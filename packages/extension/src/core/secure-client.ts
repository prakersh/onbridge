/**
 * Extension side of the onbridge secure channel.
 *
 * Wraps a WebSocket with the ECDH handshake, pairing, and AES-GCM framing so the
 * background script only ever sees plaintext messages.
 *
 * The pairing secret lives in `chrome.storage.local`, which is extension-private
 * — no web page can reach it. It is never sent anywhere.
 */

import {
  HANDSHAKE_VERSION,
  PROOF_PAIR,
  PROOF_AUTH_EXT,
  PROOF_AUTH_SRV,
  WS_PORT_RANGE,
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
import type { ExtensionMessage, HandshakeFrame, ServerMessage } from '@onbridge/shared';

const PAIRINGS_KEY = 'onbridge_pairings';

export type ClientState = 'idle' | 'connecting' | 'pairing' | 'authenticating' | 'ready' | 'failed';

export interface SecureClientHooks {
  /** Resolve true to pair. The user must actively choose — never auto-resolve. */
  onPairRequest: (agentName: string) => Promise<boolean>;
  onMessage: (msg: ServerMessage) => void;
  onState: (state: ClientState, detail?: string) => void;
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

  constructor(private hooks: SecureClientHooks) {}

  isReady(): boolean {
    return this.state === 'ready' && this.ws?.readyState === WebSocket.OPEN;
  }

  getState(): ClientState {
    return this.state;
  }

  private setState(s: ClientState, detail?: string): void {
    this.state = s;
    this.hooks.onState(s, detail);
  }

  /** Probes the port range; the server binds the first free one. */
  async connect(portHint?: number): Promise<void> {
    const ports = portHint ? [portHint, ...WS_PORT_RANGE.filter((p) => p !== portHint)] : WS_PORT_RANGE;
    this.setState('connecting');

    for (const port of ports) {
      try {
        await this.tryPort(port);
        return;
      } catch {
        // Port not serving onbridge, or handshake refused. Try the next.
      }
    }
    this.setState('failed', 'No onbridge MCP server found on ports 9876-9885.');
  }

  private tryPort(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const giveUp = (why: string) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        reject(new Error(why));
      };

      const timer = setTimeout(() => giveUp('timeout'), 5000);

      ws.onopen = () => void this.sendHello(ws);

      // Frames must be processed strictly in order: `hello_ack` derives the keys
      // that the very next frame needs, and the replay guard requires monotonic
      // counters. Chaining onto a single promise serialises them — without this,
      // two frames arriving together race and the second fails to decrypt.
      let queue: Promise<void> = Promise.resolve();
      ws.onmessage = (ev) => {
        queue = queue.then(async () => {
          try {
            await this.handleFrame(ws, JSON.parse(ev.data as string) as HandshakeFrame);
            if (this.state === 'ready' && !settled) {
              settled = true;
              clearTimeout(timer);
              this.ws = ws;
              resolve();
            }
          } catch (err) {
            clearTimeout(timer);
            giveUp((err as Error).message);
          }
        });
      };

      ws.onerror = () => {
        clearTimeout(timer);
        giveUp('socket error');
      };

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
      this.hooks.onMessage(inner as ServerMessage);
      return;
    }

    const hs = inner as HandshakeFrame;

    if (hs.t === 'pair_required') {
      const allowed = await this.hooks.onPairRequest(hs.agentName);
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

  private pendingChallenge?: string;

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

  disconnect(): void {
    const ws = this.ws;
    this.ws = null;
    this.sessionKey = undefined;
    this.pairingSecret = undefined;
    this.shared = undefined;
    ws?.close();
    this.setState('idle');
  }
}
