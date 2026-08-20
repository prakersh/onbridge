/**
 * Extension side of the onbridge secure channel — one socket to one agent.
 *
 * Wraps a WebSocket with the ECDH handshake, pairing, and AES-GCM framing so the
 * background script only ever sees plaintext messages.
 *
 * This class owns exactly one port. Discovering which ports have agents on them,
 * and deciding which of several agents is in control, belongs to
 * `ConnectionManager` — keeping that out of here is what makes several
 * simultaneous agents possible.
 *
 * The pairing secret lives in `chrome.storage.local`, which is extension-private
 * — no web page can reach it. It is never sent anywhere.
 */

import {
  HANDSHAKE_VERSION,
  PROOF_PAIR,
  PROOF_AUTH_EXT,
  PROOF_AUTH_SRV,
  computeSessionId,
  deriveHandshakeKeys,
  deriveSessionKey,
  deriveSharedSecret,
  generateEphemeralKeyPair,
  fromB64,
  makeProof,
  open as openFrame,
  randomBytes,
  seal,
  toB64,
  verifyProof,
  ReplayGuard,
} from '@onbridge/shared';
import type {
  AgentIdentity,
  ExtensionMessage,
  HandshakeFrame,
  ServerMessage,
} from '@onbridge/shared';

const PAIRINGS_KEY = 'onbridge_pairings';

/**
 * How long we wait for a port to prove it is an onbridge server, i.e. to answer
 * `hello` with `hello_ack`. Short, because we probe ten ports and most are dead.
 */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * How long the rest of the handshake may take once a server has answered.
 *
 * This has to outlast a human reading the pairing prompt and clicking Allow.
 * It previously shared the probe's 3-5s budget, which meant the client hung up
 * on the server *while the prompt was still on screen*, retried, and re-prompted
 * — the connect/disconnect storm that made first-time pairing feel broken. The
 * server allows 90s for the same reason; these two numbers must stay in step.
 */
const HANDSHAKE_TIMEOUT_MS = 90_000;

export type ClientState =
  | 'idle'
  | 'connecting'
  | 'pairing'
  | 'authenticating'
  | 'ready'
  | 'failed';

export interface SecureClientHooks {
  /**
   * Resolve true to pair. The user must actively choose — never auto-resolve.
   *
   * `wasPaired` means we still hold a secret for this server but it no longer
   * recognises us. That is the visible trace of a pairing record being reset,
   * which has an innocent cause (someone cleared `~/.onbridge`) and a hostile
   * one (another local process claimed our extension id, reset the record and
   * paired itself). The server cannot tell those apart — it has no way to see
   * that a human approved anything — so the decision belongs here, in front of
   * the person, with the anomaly stated rather than swallowed.
   */
  onPairRequest: (agent: AgentIdentity, opts: { wasPaired: boolean }) => Promise<boolean>;
  onMessage: (msg: ServerMessage) => void;
  onState: (state: ClientState, detail?: string) => void;
  /** Fired when the agent's identity first arrives, and again if it is refined. */
  onIdentity?: (agent: AgentIdentity) => void;
}

async function loadPairing(serverId: string): Promise<Uint8Array | undefined> {
  const all = (await chrome.storage.local.get(PAIRINGS_KEY))[PAIRINGS_KEY] as
    | Record<string, string>
    | undefined;
  const stored = all?.[serverId];
  return stored ? fromB64(stored) : undefined;
}

async function savePairing(serverId: string, secret: Uint8Array): Promise<void> {
  const all =
    ((await chrome.storage.local.get(PAIRINGS_KEY))[PAIRINGS_KEY] as Record<string, string>) ?? {};
  all[serverId] = toB64(secret);
  await chrome.storage.local.set({ [PAIRINGS_KEY]: all });
}

export async function clearPairings(): Promise<void> {
  await chrome.storage.local.remove(PAIRINGS_KEY);
}

export class SecureClient {
  private ws: WebSocket | null = null;
  private state: ClientState = 'idle';
  private txCounter = 0;
  private replay = new ReplayGuard();
  /**
   * Set once this client is retired. Every callback checks it, so a client the
   * manager has moved on from can never resurrect itself — abandoned clients
   * firing `onState` late is what used to multiply reconnect attempts.
   */
  private disposed = false;

  private priv?: CryptoKey;
  private ePub = '';
  private eNonce = '';
  private handshakeKey?: CryptoKey;
  private sessionKey?: CryptoKey;
  private pairingSecret?: Uint8Array;
  private shared?: Uint8Array;
  private sNonce?: Uint8Array;
  private sessionId = '';
  private serverId = '';
  private identity?: AgentIdentity;
  private pendingChallenge?: string;
  /** See `onPairRequest`: this server forgot a pairing we still hold. */
  private pairingWasReset = false;

  constructor(
    readonly port: number,
    private hooks: SecureClientHooks,
  ) {}

  isReady(): boolean {
    return this.state === 'ready' && this.ws?.readyState === WebSocket.OPEN;
  }

  getState(): ClientState {
    return this.state;
  }

  getServerId(): string {
    return this.serverId;
  }

  getIdentity(): AgentIdentity | undefined {
    return this.identity;
  }

  private setState(s: ClientState, detail?: string): void {
    if (this.disposed) return;
    this.state = s;
    this.hooks.onState(s, detail);
  }

  /**
   * Runs the whole handshake against this client's port. Rejects if the port is
   * not serving onbridge, if the user denies pairing, or if authentication
   * fails — the manager treats those differently.
   */
  connect(): Promise<void> {
    this.setState('connecting');

    return new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      } catch (err) {
        return reject(err as Error);
      }

      const giveUp = (why: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        reject(new Error(why));
      };

      // Starts as a probe budget and is extended once the server proves it
      // speaks onbridge. See PROBE_TIMEOUT_MS / HANDSHAKE_TIMEOUT_MS.
      let timer = setTimeout(() => giveUp('no onbridge server on this port'), PROBE_TIMEOUT_MS);
      const extendDeadline = () => {
        clearTimeout(timer);
        timer = setTimeout(() => giveUp('handshake timed out'), HANDSHAKE_TIMEOUT_MS);
      };

      ws.onopen = () => void this.sendHello(ws);

      // Frames must be processed strictly in order: `hello_ack` derives the keys
      // that the very next frame needs, and the replay guard requires monotonic
      // counters. Chaining onto a single promise serialises them — without this,
      // two frames arriving together race and the second fails to decrypt.
      let queue: Promise<void> = Promise.resolve();
      ws.onmessage = (ev) => {
        queue = queue.then(async () => {
          if (this.disposed) return;
          try {
            const frame = JSON.parse(ev.data as string) as HandshakeFrame;
            // The first sign of life from a real server. Everything after this
            // may legitimately wait on a human.
            if (frame.t === 'hello_ack') extendDeadline();

            await this.handleFrame(ws, frame);

            if (this.state === 'ready' && !settled) {
              settled = true;
              clearTimeout(timer);
              this.ws = ws;
              resolve();
            }
          } catch (err) {
            giveUp((err as Error).message);
          }
        });
      };

      ws.onerror = () => giveUp('socket error');

      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (this.ws === ws) {
          this.ws = null;
          this.setState('idle', ev.reason);
        }
        giveUp(ev.reason || 'closed');
      };
    });
  }

  private async sendHello(ws: WebSocket): Promise<void> {
    const kp = await generateEphemeralKeyPair();
    this.priv = kp.privateKey;
    this.ePub = kp.publicKeyB64;
    this.eNonce = toB64(randomBytes(16));
    this.txCounter = 0;
    this.replay = new ReplayGuard();

    const hello: HandshakeFrame = {
      t: 'hello',
      v: HANDSHAKE_VERSION,
      extId: chrome.runtime.id,
      ePub: this.ePub,
      eNonce: this.eNonce,
    };
    ws.send(JSON.stringify(hello));
  }

  private noteIdentity(agent: AgentIdentity): void {
    this.identity = agent;
    this.hooks.onIdentity?.(agent);
  }

  private async handleFrame(ws: WebSocket, frame: HandshakeFrame): Promise<void> {
    if (frame.t === 'hello_ack') {
      this.serverId = frame.serverId;
      this.shared = await deriveSharedSecret(this.priv!, frame.sPub);
      this.sNonce = fromB64(frame.sNonce);
      const { handshakeKey, pairingSecret } = await deriveHandshakeKeys(
        this.shared,
        fromB64(this.eNonce),
        this.sNonce,
      );
      this.handshakeKey = handshakeKey;
      this.sessionId = await computeSessionId(this.ePub, frame.sPub, this.eNonce, frame.sNonce);

      const stored = await loadPairing(frame.serverId);
      if (frame.paired) {
        if (!stored) {
          // Server remembers us but we lost the secret (reinstall). Ask it to
          // drop the record so a fresh, user-approved pairing can run.
          await this.sendSealed(ws, this.handshakeKey, { t: 'pair_reset' });
          return;
        }
        this.pairingSecret = stored;
        this.setState('authenticating');
      } else {
        // We hold a secret for this server and it does not know us. Something
        // dropped its record; the user is told so when we ask them to pair.
        this.pairingWasReset = Boolean(stored);
        this.pairingSecret = pairingSecret;
        this.setState('pairing');
      }
      return;
    }

    if (frame.t !== 'enc') throw new Error(`unexpected frame ${frame.t}`);
    if (!this.replay.accept(frame.c)) throw new Error('replayed frame');

    const key = this.state === 'ready' ? this.sessionKey! : this.handshakeKey!;
    const inner = JSON.parse(await openFrame(key, frame)) as HandshakeFrame | ServerMessage;

    if (this.state === 'ready') {
      const msg = inner as ServerMessage;
      // Identity is refined once the agent client sends MCP `initialize`, which
      // often lands after we are already connected.
      if (msg.type === 'agent_identity') {
        this.noteIdentity(msg.agent);
        return;
      }
      this.hooks.onMessage(msg);
      return;
    }

    const hs = inner as HandshakeFrame;

    if (hs.t === 'pair_required') {
      this.noteIdentity(hs.agent);
      const allowed = await this.hooks.onPairRequest(hs.agent, { wasPaired: this.pairingWasReset });
      if (this.disposed) return;
      if (!allowed) {
        await this.sendSealed(ws, this.handshakeKey!, { t: 'pair_denied' });
        throw new Error('pairing denied');
      }
      await this.sendSealed(ws, this.handshakeKey!, {
        t: 'pair_confirm',
        proof: await makeProof(this.pairingSecret!, PROOF_PAIR, this.sessionId),
      });
      await savePairing(this.serverId, this.pairingSecret!);
      await this.promote();
      return;
    }

    if (hs.t === 'challenge') {
      this.noteIdentity(hs.agent);
      await this.sendSealed(ws, this.handshakeKey!, {
        t: 'auth',
        proof: await makeProof(this.pairingSecret!, PROOF_AUTH_EXT, this.sessionId, hs.nonce),
      });
      // Hold here: we do not trust the server until it proves it holds the
      // pairing secret too. Without this a rogue local process could impersonate
      // a previously paired agent and issue commands.
      this.pendingChallenge = hs.nonce;
      return;
    }

    if (hs.t === 'auth_ok') {
      const ok = await verifyProof(
        this.pairingSecret!,
        PROOF_AUTH_SRV,
        this.sessionId,
        this.pendingChallenge ?? '',
        hs.proof,
      );
      if (!ok) throw new Error('server failed mutual authentication');
      await this.promote();
      return;
    }

    if (hs.t === 'auth_fail') throw new Error(hs.reason);
  }

  private async promote(): Promise<void> {
    this.sessionKey = await deriveSessionKey(
      this.shared!,
      this.pairingSecret!,
      fromB64(this.eNonce),
      this.sNonce!,
    );
    this.txCounter = 0;
    this.replay = new ReplayGuard();
    this.setState('ready');
  }

  private async sendSealed(
    ws: WebSocket,
    key: CryptoKey,
    payload: HandshakeFrame | ExtensionMessage,
  ): Promise<void> {
    const sealed = await seal(key, this.txCounter++, JSON.stringify(payload));
    ws.send(JSON.stringify({ t: 'enc', ...sealed }));
  }

  async send(msg: ExtensionMessage): Promise<void> {
    if (!this.isReady()) return;
    await this.sendSealed(this.ws!, this.sessionKey!, msg);
  }

  /**
   * Closes the socket and permanently retires this client. `disposed` is what
   * stops a late callback from a client the manager already replaced.
   */
  disconnect(): void {
    this.disposed = true;
    const ws = this.ws;
    this.ws = null;
    this.sessionKey = undefined;
    this.pairingSecret = undefined;
    this.shared = undefined;
    this.state = 'idle';
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
  }
}
