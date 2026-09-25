import { WebSocketServer, WebSocket } from 'ws';
import {
  WS_PORT_RANGE,
  HEARTBEAT_INTERVAL_MS,
  COMMAND_TIMEOUT_MS,
  HANDSHAKE_VERSION,
  PROOF_PAIR,
  PROOF_AUTH_EXT,
  PROOF_AUTH_SRV,
  computeSessionId,
  deriveHandshakeKeys,
  deriveSessionKey,
  deriveSharedSecret,
  generateEphemeralKeyPair,
  makeProof,
  open as openFrame,
  randomBytes,
  seal,
  toB64,
  fromB64,
  verifyProof,
  ReplayGuard,
} from '@onbridge/shared';
import type {
  ServerMessage,
  ExtensionMessage,
  CommandAction,
  ConsoleDeltaEntry,
  HandshakeFrame,
} from '@onbridge/shared';
import {
  buildAgentIdentity,
  checkPeerIdentity,
  claimPairing,
  countListeningServers,
  pairingEvidence,
  peerRefusalHelp,
  forgetPeer,
  getPeer,
  getServerId,
  makeOriginCheck,
  originRefusalHelp,
  makeConnectionCode,
  movePeer,
  peerKey,
  savePeer,
  serverPortRange,
  touchPeer,
} from './identity.js';
import type { AgentIdentity } from '@onbridge/shared';

type PendingCommand = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** The browser it was sent to. Only that browser disconnecting fails it. */
  session: Session;
};

/**
 * Sockets open at once, handshaking or live. One per browser install is the real need, since each browser profile holds one connection to each agent; the cap only stops a local process from opening sockets without end.
 */
const MAX_CONNECTIONS = 8;

/** Generous, because first-run pairing waits on a human clicking Allow. */
const HANDSHAKE_TIMEOUT_MS = 90_000;

/**
 * How long a tool call waits for the browser to pick up an agent that has only just started listening. A current extension looks every 10s, or every 30s while its worker is suspended; the one in the store before connect-on-demand could also skip a port it had just found empty for 20s. This covers the slowest of those.
 */
const ON_DEMAND_WAIT_MS = 45_000;

/**
 * `ONBRIDGE_CONNECT=startup` listens as soon as the server starts, which is how it always worked. The default listens on the agent's first OnBridge tool call instead.
 *
 * Every editor session starts a server, including ones that never touch the browser and editors' own pre-warmed background processes. Listening at startup made each of them appear in the side panel, ask to pair and hold one of the ten ports. Listening on first use makes "connect to the browser" something the agent asks for by using it. Test harnesses that pair before calling a tool set `startup`. Resolved per call, like `ONBRIDGE_HOME`.
 */
function listenAtStartup(): boolean {
  return process.env.ONBRIDGE_CONNECT?.trim() === 'startup';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the agent hears when the browser has not connected. Worded as the next step, since the agent's only move is to ask the user, and carrying the connection code so the user can tell which request in the panel is this one. */
export function notConnectedText(code: string): string {
  return (
    'The browser is not connected to this agent. Ask the user to open the OnBridge side panel in Chrome and turn on Control Mode, ' +
    `and to approve the request showing connection code ${code}, then try again.`
  );
}

/**
 * How long to wait for a sibling server that is already running a pairing
 * prompt for this browser.
 *
 * Comfortably inside the handshake budget, so a peer that waits the whole time
 * is still refused cleanly rather than being cut off mid-wait. Nothing is shown
 * to the user while this runs — that is the point: one approval, not one per
 * server process.
 */
const PAIRING_CLAIM_BUDGET_MS = 60_000;

/** Ceiling on undelivered side-panel notes. See `handleMessage`. */
const MAX_QUEUED_USER_MESSAGES = 20;

/**
 * Marks an error as composed by onbridge rather than carrying page text, so the
 * reply builders can frame it authoritatively instead of fencing it.
 */
export function commandError(
  message: string,
  trusted: boolean,
  retry?: { code: string; retryAfterMs?: number },
): Error {
  const err = new Error(message) as Error & {
    onbridgeTrusted?: true;
    onbridgeCode?: string;
    onbridgeRetryAfterMs?: number;
  };
  if (trusted) err.onbridgeTrusted = true;
  // A code only ever accompanies a trusted error — see `errorCode` in the
  // protocol. Attaching one to page-derived text would let a page present
  // itself as a well-known onbridge condition.
  if (trusted && retry) {
    err.onbridgeCode = retry.code;
    err.onbridgeRetryAfterMs = retry.retryAfterMs;
  }
  return err;
}

/** True only for errors this stack composed. Absent means assume page-derived. */
export function isTrustedError(err: unknown): boolean {
  return Boolean((err as { onbridgeTrusted?: boolean } | null)?.onbridgeTrusted);
}

/**
 * The machine-readable condition behind a trusted failure, if there was one.
 *
 * Exists so a tool can tell the agent "this is a retry, not a refusal" without
 * the agent having to recognise a sentence.
 */
export function errorRetry(err: unknown): { code: string; retryAfterMs?: number } | undefined {
  const e = err as { onbridgeCode?: string; onbridgeRetryAfterMs?: number } | null;
  if (!isTrustedError(err) || !e?.onbridgeCode) return undefined;
  return { code: e.onbridgeCode, retryAfterMs: e.onbridgeRetryAfterMs };
}

type SessionState = 'hello' | 'pairing' | 'auth' | 'ready';

interface Session {
  ws: WebSocket;
  state: SessionState;
  extId: string;
  /** This install's key in the peer store (`peerKey`). One live session per key. */
  peerKey: string;
  /** Where the pairing record it authenticates against was found: `peerKey`, or the bare `extId` of a pairing made before install ids. */
  recordKey: string;
  connectedAt: number;
  /** When this browser last granted the agent control (`ready`); cleared by `released`. Commands go to the most recent. */
  grantedAt?: number;
  sessionId: string;
  handshakeKey: CryptoKey;
  pairingSecret: Uint8Array;
  /** Ephemeral ECDH output. Retained so the session key stays bound to it. */
  shared: Uint8Array;
  eNonce: Uint8Array;
  sNonce: Uint8Array;
  sessionKey?: CryptoKey;
  challengeNonce?: string;
  /** From the extension's `ready` message. Undefined until it arrives, and on extensions too old to send it. */
  extensionVersion?: string;
  /** The actions the extension implements. Undefined means unknown, never "none". */
  extensionActions?: ReadonlySet<string>;
  /**
   * Set when a peer asked to re-pair. The old record is only dropped once a new
   * pairing actually completes, so a peer that asks and then vanishes cannot
   * destroy a working pairing on its way out.
   */
  resetRequested?: boolean;
  /**
   * Releases the cross-process pairing claim. Held from the moment we decide to
   * prompt until the pairing resolves either way, so sibling servers wait
   * rather than racing us — and released on every exit path, including a peer
   * that simply vanishes, or the next agent to start would wait out the stale
   * lock.
   */
  releasePairing?: () => void;
  txCounter: number;
  replay: ReplayGuard;
  /**
   * Serialises outbound frames. Counters are grabbed synchronously in call
   * order, but `seal()` is async and gives no cross-call ordering guarantee — so
   * without chaining, two overlapping sends (a heartbeat colliding with a
   * command result) can put counter N+1 on the wire before N, and the peer's
   * replay guard tears the channel down as out-of-order.
   */
  sendChain: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

export class Bridge {
  private wss: WebSocketServer | null = null;
  /**
   * One per browser install. An agent can be connected to several browsers at once, so a second browser is no longer turned away with "Another client is already connected"; which one it acts in is decided per command (`target`).
   */
  private sessions = new Map<WebSocket, Session>();
  /** Every accepted socket, for the connection cap. */
  private sockets = new Set<WebSocket>();
  /**
   * The socket holding each install's slot, from its `hello` until it closes. Taken synchronously when `hello` is read, before any await, so two connections from one install cannot both pass the check and the second clobber the first's in-flight handshake.
   */
  private reserved = new Map<string, WebSocket>();
  private pending = new Map<string, PendingCommand>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cmdCounter = 0;
  private port = 0;
  private isOriginAllowed = makeOriginCheck((m) => this.log(m));
  /** Notes typed in the side panel, awaiting delivery on the next tool result. */
  private userMessages: string[] = [];
  /** Console output from the command that just finished. See `takeConsoleDelta`. */
  private consoleDelta: ConsoleDeltaEntry[] = [];
  private startedAt = Date.now();
  private serverVersion = '0.0.0';
  /**
   * How many onbridge servers are up, counted at startup.
   *
   * A user-scope MCP install spawns one per editor session, which is how a
   * single configuration line quietly turns into ten servers and exhausts the
   * port range. Counting it is the only cheap way to tell the user that is what
   * is happening.
   */
  private siblingCount = 1;
  /**
   * Pulled on demand rather than pushed once.
   *
   * The obvious wiring — set this from an `oninitialized` callback — silently
   * does nothing for any client that omits the `notifications/initialized`
   * notification, and identity then falls back to an environment guess forever.
   * Reading it at the moment we need it is correct regardless, because the SDK
   * records `clientInfo` while handling the `initialize` *request*.
   */
  private clientInfoSource?: () => { name?: string; version?: string; title?: string } | undefined;

  /** Shown by this session in its own tool results and by the panel on its request and card. See `AgentIdentity.code`. */
  private readonly code = makeConnectionCode();
  /**
   * The agent's `clientInfo` as carried on its requests. Under protocol revision 2026-07-28 there is no `initialize`: the client identifies itself in every request's `_meta` envelope, and over stdio the SDK never copies that into `getClientVersion()`. Without this every such agent (Claude Code among them) was shown as a guess.
   */
  private envelopeClientInfo?: { name?: string; version?: string; title?: string };

  /** Settles once `listen()` has bound a port or given up. Created on first need, and only once. */
  private listening?: Promise<void>;

  constructor(serverVersion?: string) {
    if (serverVersion) this.serverVersion = serverVersion;
    if (listenAtStartup()) void this.ensureListening();
  }

  ensureListening(): Promise<void> {
    return (this.listening ??= this.listen());
  }

  /**
   * Called before every tool: start listening if this is the first one, then give the browser a moment to connect.
   *
   * A pairing prompt on screen extends the wait to the handshake budget, so a first-time approval completes inside the call that caused it instead of failing it and leaving the agent to guess when to retry.
   */
  async connectOnDemand(): Promise<void> {
    if (this.isConnected()) return;
    await this.ensureListening();
    if (!this.port) return; // nothing to wait for: every port is taken, and listen() has said so
    const start = Date.now();
    while (!this.isConnected()) {
      const handshaking = [...this.sessions.values()].some((x) => x.state !== 'ready');
      const budget = handshaking ? HANDSHAKE_TIMEOUT_MS : ON_DEMAND_WAIT_MS;
      if (Date.now() - start >= budget) return;
      await sleep(250);
    }
  }

  /** Current best answer to "who is driving this server", for the pairing UI. */
  private agentIdentity(): AgentIdentity {
    return buildAgentIdentity({
      port: this.port,
      serverVersion: this.serverVersion,
      startedAt: this.startedAt,
      clientInfo: this.clientInfoSource?.() ?? this.envelopeClientInfo,
      code: this.code,
    });
  }

  getConnectionCode(): string {
    return this.code;
  }

  /** Records the identity a request carried; pushes it to connected browsers when it changes. */
  noteClientInfo(info: { name?: string; version?: string; title?: string }): void {
    const prev = this.envelopeClientInfo;
    if (prev?.name === info.name && prev?.version === info.version && prev?.title === info.title) return;
    this.envelopeClientInfo = { name: info.name, version: info.version, title: info.title };
    this.refreshIdentity();
  }

  setClientInfoSource(fn: () => { name?: string; version?: string; title?: string } | undefined): void {
    this.clientInfoSource = fn;
  }

  /**
   * Pushes a refreshed identity to an already-connected extension. The bridge
   * usually finishes its handshake before the agent client has introduced
   * itself, so without this the panel would keep showing the first guess.
   */
  refreshIdentity(): void {
    const agent = this.agentIdentity();
    this.log(`agent identified: ${agent.name}${agent.version ? ` ${agent.version}` : ''}`);
    for (const s of this.readySessions()) void this.sendSealed(s, s.sessionKey!, { type: 'agent_identity', agent });
  }

  /**
   * Binds loopback only. Scans the port range so several agents can run at once,
   * each owning its own port; the extension probes the same range.
   */
  private async listen(): Promise<void> {
    const range = serverPortRange();
    for (const port of range) {
      try {
        this.wss = await this.bind(port);
        this.port = port;
        this.log(`listening on 127.0.0.1:${port}`);
        this.attachHandlers();
        void this.reportSiblings();
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE') {
          this.log(`failed to bind ${port}: ${(err as Error).message}`);
        }
      }
    }
    this.log(`could not bind any port in ${range[0]}-${range[range.length - 1]}`);
  }

  /** Counts and reports the other onbridge servers sharing this machine. */
  private async reportSiblings(): Promise<void> {
    try {
      this.siblingCount = Math.max(1, await countListeningServers());
    } catch {
      return;
    }
    if (this.siblingCount < 3) return;
    this.log(
      `${this.siblingCount} onbridge servers are listening on this machine. Each keeps its port until its ` +
        `agent session ends, and the range holds ${WS_PORT_RANGE.length}; past that no new agent can connect.`,
    );
  }

  /** For the panel and for `auth_fail` evidence. */
  getSiblingCount(): number {
    return this.siblingCount;
  }

  private bind(port: number): Promise<WebSocketServer> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        port,
        host: '127.0.0.1',
        verifyClient: ({ origin }, done) => {
          if (this.isOriginAllowed(origin)) return done(true);
          this.log(`rejected connection from disallowed origin: ${origin ?? '(none)'}. ${originRefusalHelp(origin)}`);
          done(false, 403, 'Forbidden origin');
        },
      });
      const onError = (err: Error) => {
        wss.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        wss.removeListener('error', onError);
        resolve(wss);
      };
      wss.once('error', onError);
      wss.once('listening', onListening);
    });
  }

  private attachHandlers(): void {
    this.wss!.on('connection', (ws, req) => {
      if (this.sockets.size >= MAX_CONNECTIONS) {
        ws.close(4000, 'Too many connections');
        return;
      }
      this.sockets.add(ws);
      // Chrome sets Origin itself, so it is the one part of a peer's claimed
      // identity it does not get to choose. `hello` is checked against it.
      this.handleConnection(ws, req.headers.origin);
    });
  }

  /**
   * Not async: listeners must be attached synchronously. Generating the keypair
   * before subscribing left a window in which the client's `hello` — sent
   * immediately on open — arrived with no listener and was dropped, hanging the
   * handshake. The queue awaits `setup` instead, so frames are held, not lost.
   */
  private handleConnection(ws: WebSocket, origin?: string): void {
    const setup = (async () => ({
      kp: await generateEphemeralKeyPair(),
      sNonce: toB64(randomBytes(16)),
    }))();

    const fail = (reason: string) => {
      this.log(`handshake failed: ${reason}`);
      // A pairing claim left behind makes every sibling wait out its stale
      // timeout before anyone can pair again.
      const s = this.sessions.get(ws);
      if (s) {
        s.releasePairing?.();
        s.releasePairing = undefined;
      }
      this.closeWithReason(ws, 4001, reason);
    };

    // Serialised for the same reason as on the client: `hello` derives the keys
    // the next frame needs, and the replay guard demands monotonic ordering.
    let queue: Promise<void> = Promise.resolve();

    ws.on('message', (raw) => {
      queue = queue.then(async () => {
        const { kp, sNonce } = await setup;
        let frame: HandshakeFrame;
        try {
          frame = JSON.parse(raw.toString()) as HandshakeFrame;
        } catch {
          return fail('malformed frame');
        }

        // Once a session is established, everything is sealed.
        const existing = this.sessions.get(ws);
        if (existing) return this.handleSessionFrame(existing, frame);

        try {
          if (frame.t === 'hello') {
            if (frame.v !== HANDSHAKE_VERSION) {
              // Say which side is behind. "unsupported version 1" sent people
              // hunting for a crypto fault instead of running an update.
              const who = frame.v < HANDSHAKE_VERSION ? 'browser extension' : 'onbridge MCP server';
              return fail(
                `handshake version mismatch (extension speaks v${frame.v}, server speaks ` +
                  `v${HANDSHAKE_VERSION}) — update the ${who}`,
              );
            }

            // Binds the claimed extension id to the connection, and pins the
            // first id we ever pair with. Without this the `pair_confirm` proof
            // proves nothing about *who* is pairing: it is derived from the key
            // exchange the peer just performed, so any peer can produce one.
            const refusal = checkPeerIdentity(frame.extId, origin);
            if (refusal) {
              this.log(peerRefusalHelp(frame.extId));
              return fail(refusal);
            }

            // One live connection per browser install. Checked and reserved in the same synchronous step, before any await below. Only a holder whose socket is already gone is replaced: the extension's worker can be killed without a clean close and must be able to come back, but evicting a *live* session would let anyone who passes the origin check kick the real browser off.
            const key = peerKey(frame.extId, frame.installId);
            const holder = this.reserved.get(key);
            if (holder && holder !== ws) {
              if (holder.readyState === WebSocket.OPEN) {
                ws.close(4000, 'Another client is already connected');
                return;
              }
              this.log('replacing a stale session');
              this.teardown(holder);
            }
            this.reserved.set(key, ws);

            const shared = await deriveSharedSecret(kp.privateKey, frame.ePub);
            const { handshakeKey, pairingSecret } = await deriveHandshakeKeys(
              shared,
              fromB64(frame.eNonce),
              fromB64(sNonce),
            );
            const sessionId = await computeSessionId(frame.ePub, kp.publicKeyB64, frame.eNonce, sNonce);
            const serverId = getServerId();
            // A pairing made before install ids is filed under the bare extension id. It is still honoured, and moved to this install's key the first time it authenticates.
            let recordKey = key;
            let known = getPeer(key, serverId);
            if (!known && key !== frame.extId) {
              known = getPeer(frame.extId, serverId);
              if (known) recordKey = frame.extId;
            }
            // The peer can have gone while the key exchange was awaited.
            if (this.reserved.get(key) !== ws || ws.readyState !== WebSocket.OPEN) return;

            const session: Session = {
              ws,
              state: known ? 'auth' : 'pairing',
              extId: frame.extId,
              peerKey: key,
              recordKey,
              connectedAt: Date.now(),
              sessionId,
              handshakeKey,
              // A known peer authenticates with the stored secret; a new peer
              // uses the freshly derived one, which both sides computed from the
              // same ECDH without ever transmitting it.
              pairingSecret: known ? fromB64(known.pairingSecret) : pairingSecret,
              shared,
              eNonce: fromB64(frame.eNonce),
              sNonce: fromB64(sNonce),
              txCounter: 0,
              replay: new ReplayGuard(),
              sendChain: Promise.resolve(),
              timer: setTimeout(() => fail('handshake timed out'), HANDSHAKE_TIMEOUT_MS),
            };
            this.sessions.set(ws, session);

            this.sendPlain(ws, {
              t: 'hello_ack',
              sPub: kp.publicKeyB64,
              sNonce,
              serverId,
              paired: Boolean(known),
            });

            if (known) return this.sendChallenge(session);

            // No record — but "no record" is not the same as "nobody is
            // pairing". Every agent session spawns its own server against one
            // shared `~/.onbridge`, so several can arrive here at once; if each
            // prompts and each derives its own secret, the two stores end up
            // holding different ones and the browser dead-ends at `invalid auth
            // proof` forever. Exactly one runs the prompt; the rest wait and
            // then authenticate with what it wrote.
            const claim = await claimPairing(key, serverId, PAIRING_CLAIM_BUDGET_MS);
            // The peer can disconnect while we wait on a sibling's prompt.
            if (this.sessions.get(ws) !== session || ws.readyState !== WebSocket.OPEN) {
              claim.release();
              return;
            }
            if (claim.waited) {
              this.log(
                `waited for another onbridge server to finish pairing with ${frame.extId}`,
              );
            }

            if (claim.record) {
              // A sibling paired while we waited. Authenticate against its
              // record rather than starting a second pairing, which is what the
              // extension is expecting too — it decides which secret to use
              // from this frame, not from `hello_ack`.
              session.pairingSecret = fromB64(claim.record.pairingSecret);
              session.recordKey = key;
              session.state = 'auth';
              return this.sendChallenge(session);
            }
            if (!claim.pair) {
              return fail(
                'another onbridge server is pairing with this browser; retry in a moment',
              );
            }

            session.releasePairing = claim.release;
            await this.sendSealed(session, session.handshakeKey, {
              t: 'pair_required',
              agent: this.agentIdentity(),
            });
            return;
          }

          return fail(`unexpected frame ${frame.t} before hello`);
        } catch (err) {
          return fail((err as Error).message);
        }
      })
      // A hostile or buggy peer must never be able to take the MCP server down.
      // Without this, any throw in the chain surfaces as an unhandled rejection
      // and Node exits the whole process.
      .catch((err: unknown) => {
        this.log(`frame handler error: ${(err as Error).message}`);
        try {
          this.closeWithReason(ws, 4002, 'internal error');
        } catch {
          /* already closed */
        }
      });
    });

    // Releases the install's slot and the connection count too, so a peer that connects and drops before `hello` cannot lock anyone out.
    ws.on('close', () => this.teardown(ws));
    ws.on('error', (err) => this.log(`socket error: ${err.message}`));
  }

  private async sendChallenge(s: Session): Promise<void> {
    const nonce = toB64(randomBytes(16));
    s.challengeNonce = nonce;
    await this.sendSealed(s, s.handshakeKey, {
      t: 'challenge',
      nonce,
      agent: this.agentIdentity(),
    });
  }

  /** Frames after `hello`: sealed under the handshake key, then the session key. */
  private async handleSessionFrame(s: Session, frame: HandshakeFrame): Promise<void> {
    const fail = (reason: string) => {
      this.log(`session rejected: ${reason}`);
      this.closeWithReason(s.ws, 4001, reason);
    };

    if (frame.t !== 'enc') return fail(`expected sealed frame, got ${frame.t}`);
    if (!s.replay.accept(frame.c)) return fail('replayed or out-of-order frame');

    const key = s.state === 'ready' ? s.sessionKey! : s.handshakeKey;
    let inner: HandshakeFrame | ExtensionMessage;
    try {
      inner = JSON.parse(await openFrame(key, frame)) as HandshakeFrame | ExtensionMessage;
    } catch {
      // Under the session key this means the peer derived different keys, which
      // means it does not hold the pairing secret.
      return fail('decryption failed');
    }

    if (s.state === 'ready') return this.handleMessage(s, inner as ExtensionMessage);

    const hs = inner as HandshakeFrame;

    if (s.state === 'pairing') {
      if (hs.t === 'pair_denied') return fail('user denied pairing');
      if (hs.t !== 'pair_confirm') return fail(`expected pair_confirm, got ${hs.t}`);
      if (!(await verifyProof(s.pairingSecret, PROOF_PAIR, s.sessionId, '', hs.proof))) {
        return fail('invalid pairing proof');
      }
      const serverId = getServerId();
      // A reset replaces this install's own record only. A pre-install-id record found under the bare extension id may belong to another browser profile that has not updated yet, so it is left alone.
      if (s.resetRequested) forgetPeer(s.peerKey, serverId);
      savePeer(s.peerKey, serverId, toB64(s.pairingSecret));
      s.recordKey = s.peerKey;
      this.log(`paired with extension ${s.peerKey}`);
      // The user chose this browser for this agent. Any other browser still showing its pairing prompt has it withdrawn rather than left waiting, and treats that as a decision, not an error.
      for (const other of this.sessions.values()) {
        if (other !== s && other.state === 'pairing' && other.peerKey !== s.peerKey) {
          this.log(`withdrawing the pairing prompt from ${other.peerKey}: paired in another browser`);
          // Released now, not when the close handshake completes: that browser may ask again as soon as the user invites the agent back, and must not wait out a lock nobody is using.
          other.releasePairing?.();
          other.releasePairing = undefined;
          this.closeWithReason(other.ws, 4003, 'paired in another browser');
        }
      }
      await this.promote(s);
      // Only now: a sibling that has been waiting will read this record and
      // authenticate with it, and it must not be able to read a half-written
      // pairing. Releasing before promotion would hand it a secret the
      // extension might not have committed yet.
      s.releasePairing?.();
      s.releasePairing = undefined;
      return;
    }

    if (s.state === 'auth') {
      // Extension lost its secret (typically a reinstall). Drop our record and
      // fall back to a fresh pairing, which the user must still approve.
      if (hs.t === 'pair_reset') {
        // Deliberately does NOT drop the record yet — see `resetRequested`.
        s.resetRequested = true;
        this.log(`peer ${s.peerKey} requested pairing reset`);
        const { pairingSecret } = await deriveHandshakeKeys(s.shared, s.eNonce, s.sNonce);
        if (this.sessions.get(s.ws) !== s) return;
        s.pairingSecret = pairingSecret;
        s.state = 'pairing';
        // Take the pairing claim for this one too. A reset is a pairing, and a
        // sibling starting one in parallel would clobber it the same way.
        const claim = await claimPairing(s.peerKey, getServerId(), PAIRING_CLAIM_BUDGET_MS);
        if (this.sessions.get(s.ws) !== s || s.ws.readyState !== WebSocket.OPEN) {
          claim.release();
          return;
        }
        // A record appearing while we waited belongs to a sibling's fresh
        // pairing, not to the one being reset; the reset still has to run, so
        // the claim is taken regardless and only the wait mattered.
        s.releasePairing = claim.release;
        return this.sendSealed(s, s.handshakeKey, {
          t: 'pair_required',
          agent: this.agentIdentity(),
        });
      }
      if (hs.t !== 'auth') return fail(`expected auth, got ${hs.t}`);
      const ok = await verifyProof(
        s.pairingSecret,
        PROOF_AUTH_EXT,
        s.sessionId,
        s.challengeNonce ?? '',
        hs.proof,
      );
      if (!ok) {
        // Say what we actually know before hanging up. The browser sees only
        // "invalid auth proof", which has an innocent cause (a stale secret
        // from an abandoned session) and a hostile one (another local process
        // took this pairing over) — and the panel used to assert the hostile
        // reading as fact. The server is holding the evidence that separates
        // them: a record that has not been rewritten since it was created was
        // not replaced by anybody.
        await this.sendSealed(s, s.handshakeKey, {
          t: 'auth_fail',
          reason: 'invalid auth proof',
          evidence: {
            ...pairingEvidence(s.recordKey, getServerId()),
            siblingServers: this.siblingCount,
          },
        });
        return fail('invalid auth proof');
      }

      // Mutual: prove to the extension that we hold the pairing secret too, so a
      // rogue local server cannot impersonate a previously paired agent.
      await this.sendSealed(s, s.handshakeKey, {
        t: 'auth_ok',
        proof: await makeProof(s.pairingSecret, PROOF_AUTH_SRV, s.sessionId, s.challengeNonce ?? ''),
      });
      // Forced: this is a real authentication, and it is the event that makes
      // `lastSeen` mean something. Heartbeats touch it too, throttled.
      const serverId = getServerId();
      if (s.recordKey !== s.peerKey) {
        // Proven to hold the secret of a pre-install-id pairing, so it is this install's: file it under this install's key.
        movePeer(s.recordKey, s.peerKey, serverId);
        s.recordKey = s.peerKey;
        this.log(`moved pairing for ${s.extId} to this browser install`);
      }
      touchPeer(s.recordKey, serverId, true);
      return this.promote(s);
    }
  }

  /**
   * Takes the session explicitly and re-checks it after every await. A peer that
   * disconnects mid-promotion used to vanish from under us and take the
   * whole process down with a TypeError — a one-line local denial of service.
   */
  private async promote(s: Session): Promise<void> {
    clearTimeout(s.timer);
    // Bound to BOTH the ephemeral ECDH output (forward secrecy: stealing the
    // stored pairing secret later does not decrypt a capture from today) and the
    // pairing secret (a peer without it derives a different key, so every frame
    // it sends fails to decrypt).
    const sessionKey = await deriveSessionKey(s.shared, s.pairingSecret, s.eNonce, s.sNonce);
    if (this.sessions.get(s.ws) !== s) return; // peer went away mid-handshake

    s.sessionKey = sessionKey;
    s.state = 'ready';
    s.txCounter = 0;
    s.replay = new ReplayGuard();
    this.log('secure channel established');
    this.startHeartbeat();
  }

  /**
   * Closes with a reason the wire can actually carry.
   *
   * A WebSocket close reason is capped at 123 *bytes*, and `ws` throws a
   * RangeError past it rather than truncating. A refusal message that grew too
   * explanatory therefore crashed the handler instead of rejecting the peer —
   * turning a clean "no" into an internal error. The full text still goes to the
   * log, which is where anyone debugging a refusal will look.
   */
  private closeWithReason(ws: WebSocket, code: number, reason: string): void {
    const enc = new TextEncoder();
    let wire = reason;
    if (enc.encode(wire).length > 120) {
      while (enc.encode(wire).length > 117 && wire.length > 0) wire = wire.slice(0, -1);
      wire += '...';
    }
    try {
      ws.close(code, wire);
    } catch {
      ws.terminate();
    }
  }

  private sendPlain(ws: WebSocket, frame: HandshakeFrame): void {
    ws.send(JSON.stringify(frame));
  }

  private sendSealed(s: Session, key: CryptoKey, payload: HandshakeFrame | ServerMessage): Promise<void> {
    // Grab the counter synchronously so frames are numbered in call order, then
    // chain the async seal+send so they also reach the wire in that order.
    const counter = s.txCounter++;
    const data = JSON.stringify(payload);
    s.sendChain = s.sendChain.then(async () => {
      const sealed = await seal(key, counter, data);
      // The session may have been replaced or closed while this waited its turn.
      if (this.sessions.get(s.ws) === s && s.ws.readyState === WebSocket.OPEN) {
        s.ws.send(JSON.stringify({ t: 'enc', ...sealed }));
      }
    });
    return s.sendChain;
  }

  private teardown(ws: WebSocket): void {
    this.sockets.delete(ws);
    for (const [key, holder] of this.reserved) if (holder === ws) this.reserved.delete(key);
    const s = this.sessions.get(ws);
    if (!s) return;
    clearTimeout(s.timer);
    // A peer that vanishes mid-prompt must not leave siblings queued behind a
    // lock nobody will ever release.
    s.releasePairing?.();
    this.sessions.delete(ws);
    if (this.sessions.size === 0) this.stopHeartbeat();
    this.log('extension disconnected');
    for (const [id, cmd] of this.pending) {
      if (cmd.session !== s) continue;
      cmd.reject(commandError('Extension disconnected', true));
      clearTimeout(cmd.timer);
      this.pending.delete(id);
    }
  }

  private readySessions(): Session[] {
    return [...this.sessions.values()].filter((s) => s.state === 'ready' && s.ws.readyState === WebSocket.OPEN);
  }

  /**
   * The browser this agent's commands go to: the one that granted it control most recently, else the most recently connected. With one browser that is simply the browser. With two, it is the one where the user last pressed "Give this agent control", which is the one they are looking at. A browser that has not granted anything answers with a refusal telling the agent to ask for control, which is the right answer.
   */
  private target(): Session | undefined {
    const ready = this.readySessions();
    const granted = ready.filter((s) => s.grantedAt != null).sort((a, b) => b.grantedAt! - a.grantedAt!);
    return granted[0] ?? ready.sort((a, b) => b.connectedAt - a.connectedAt)[0];
  }

  isConnected(): boolean {
    return this.readySessions().length > 0;
  }

  getPort(): number {
    return this.port;
  }

  /**
   * Takes up to `limit` queued side-panel notes. Called when building a tool
   * result: MCP has no server-initiated channel into a running turn, so
   * piggybacking on the next result is the only way an unsolicited note reaches
   * the agent.
   *
   * The remainder stays queued rather than being dropped. Draining the whole
   * array and then truncating meant a sixth note the user genuinely typed was
   * destroyed instead of arriving on the following result.
   */
  takeUserMessages(limit = 5): string[] {
    return this.userMessages.splice(0, limit);
  }

  /**
   * Console output recorded during the command that just completed, consumed
   * once by the reply builders.
   *
   * Draining rather than reading is what keeps it attached to the action that
   * caused it: left in place, the same lines would be appended to every later
   * result and read as though the page had just produced them again.
   */
  takeConsoleDelta(): ConsoleDeltaEntry[] {
    const out = this.consoleDelta;
    this.consoleDelta = [];
    return out;
  }

  async sendCommand(
    action: CommandAction,
    params: Record<string, unknown> = {},
    tabId?: number,
    timeoutMs: number = COMMAND_TIMEOUT_MS,
  ): Promise<unknown> {
    const target = this.target();
    if (!target) throw commandError(notConnectedText(this.code), true);

    // The server ships through npm far more often than the extension through the store, so a newer server meeting an older extension is the normal case. Say so plainly rather than send a command it cannot run.
    const supported = target.extensionActions;
    if (supported && !supported.has(action)) {
      throw commandError(
        `This needs a newer onbridge browser extension: v${target.extensionVersion ?? '?'} does not support "${action}". ` +
          'Chrome updates extensions automatically; the user can also update it now from chrome://extensions.',
        true,
        { code: 'unsupported-action' },
      );
    }

    const id = `cmd_${++this.cmdCounter}`;
    const msg: ServerMessage = { type: 'command', id, action, params };
    if (tabId != null) msg.tabId = tabId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(commandError(`Command '${action}' timed out after ${timeoutMs}ms`, true));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, session: target });
      void this.sendSealed(target, target.sessionKey!, msg);
    });
  }

  /** The connected extension's version, once it has said. */
  getExtensionVersion(): string | undefined {
    return this.target()?.extensionVersion;
  }

  private handleMessage(s: Session, msg: ExtensionMessage): void {
    switch (msg.type) {
      case 'ready':
        this.log(`extension ready: v${msg.version}`);
        s.extensionVersion = msg.version;
        // Replaced, never merged: each `ready` describes the extension as it is now.
        s.extensionActions = Array.isArray(msg.actions) ? new Set(msg.actions) : undefined;
        // Control is in one browser at a time. The one that had it is told, so its panel stops showing the agent as its own.
        for (const other of this.readySessions()) {
          if (other !== s && other.grantedAt != null) {
            other.grantedAt = undefined;
            void this.sendSealed(other, other.sessionKey!, { type: 'control_moved' });
          }
        }
        s.grantedAt = Date.now();
        break;

      case 'released':
        s.grantedAt = undefined;
        break;

      case 'result': {
        const cmd = this.pending.get(msg.id);
        if (!cmd) break;
        clearTimeout(cmd.timer);
        this.pending.delete(msg.id);
        // Console output produced *while this command ran* rides along on the
        // result and is lifted off here, before the data reaches the tool.
        // Taken on the failure path too: an action that threw is exactly when
        // the page's console explains why, and a tool that only reports console
        // output on success hides it at the moment it matters most.
        this.consoleDelta = Array.isArray(msg.consoleDelta) ? msg.consoleDelta : [];
        if (msg.success) cmd.resolve(msg.data);
        else
          cmd.reject(
            commandError(
              msg.error ?? 'Command failed',
              msg.errorKind === 'trusted',
              msg.errorCode ? { code: msg.errorCode, retryAfterMs: msg.retryAfterMs } : undefined,
            ),
          );
        break;
      }

      case 'event':
        if (msg.event === 'user_message') {
          const { text } = (msg.data ?? {}) as { text?: string };
          // Bounded at the door, not only at delivery. If the agent is idle
          // nothing drains this, so an unbounded push is a memory-growth
          // primitive for whatever holds the socket. Oldest notes fall off,
          // because the newest is the one still worth acting on.
          if (text?.trim()) {
            this.userMessages.push(text.trim());
            if (this.userMessages.length > MAX_QUEUED_USER_MESSAGES) {
              this.userMessages.splice(0, this.userMessages.length - MAX_QUEUED_USER_MESSAGES);
            }
          }
        }
        this.log(`event: ${msg.event}`);
        break;

      case 'pong':
        break;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      for (const s of this.readySessions()) {
        void this.sendSealed(s, s.sessionKey!, { type: 'ping' });
        // Keeps `lastSeen` honest for the life of a long session. Throttled
        // inside `touchPeer`, so this is not a file write every fifteen seconds.
        touchPeer(s.recordKey, getServerId());
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private log(msg: string): void {
    process.stderr.write(`[onbridge] ${msg}\n`);
  }

  close(): void {
    this.stopHeartbeat();
    for (const ws of this.sockets) ws.close();
    this.wss?.close();
  }
}
