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
  savePeer,
  touchPeer,
} from './identity.js';
import type { AgentIdentity } from '@onbridge/shared';

type PendingCommand = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Generous, because first-run pairing waits on a human clicking Allow. */
const HANDSHAKE_TIMEOUT_MS = 90_000;

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
  sessionId: string;
  handshakeKey: CryptoKey;
  pairingSecret: Uint8Array;
  /** Ephemeral ECDH output. Retained so the session key stays bound to it. */
  shared: Uint8Array;
  eNonce: Uint8Array;
  sNonce: Uint8Array;
  sessionKey?: CryptoKey;
  challengeNonce?: string;
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
  private session: Session | null = null;
  /**
   * A socket that has been accepted and is mid-handshake but has not yet become
   * `this.session`. Reserved synchronously at accept so a second connection
   * cannot slip in and clobber an in-flight handshake before `hello` is
   * processed. Cleared once the session is assigned, or the socket fails/closes.
   */
  private claiming: WebSocket | null = null;
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

  constructor(serverVersion?: string) {
    if (serverVersion) this.serverVersion = serverVersion;
    void this.listen();
  }

  /** Current best answer to "who is driving this server", for the pairing UI. */
  private agentIdentity(): AgentIdentity {
    return buildAgentIdentity({
      port: this.port,
      serverVersion: this.serverVersion,
      startedAt: this.startedAt,
      clientInfo: this.clientInfoSource?.(),
    });
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
    if (this.isConnected()) {
      void this.sendSealed(this.session!.sessionKey!, { type: 'agent_identity', agent });
    }
  }

  /**
   * Binds loopback only. Scans the port range so several agents can run at once,
   * each owning its own port; the extension probes the same range.
   */
  private async listen(): Promise<void> {
    for (const port of WS_PORT_RANGE) {
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
    this.log(`could not bind any port in ${WS_PORT_RANGE[0]}-${WS_PORT_RANGE[WS_PORT_RANGE.length - 1]}`);
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
      `${this.siblingCount} onbridge servers are listening on this machine. That usually ` +
        'means onbridge is configured at user scope, so every editor session starts one. ' +
        `The range holds ${WS_PORT_RANGE.length}; past that no new agent can connect.`,
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
          this.log(`rejected connection from disallowed origin: ${origin ?? '(none)'}`);
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
      // Only ever evict a session whose socket is already gone. The extension's
      // service worker can be killed and restarted without a clean close, and it
      // must be able to reconnect. Evicting a *live* session would let anyone who
      // passes the origin check kick the real extension off the bridge.
      if (this.session && this.session.ws.readyState !== WebSocket.OPEN) {
        this.log('replacing a stale session');
        this.teardown(this.session.ws);
      }
      if (this.session) {
        ws.close(4000, 'Another client is already connected');
        return;
      }
      // Reserve the slot synchronously, at accept, not when `hello` is finally
      // processed. `this.session` is assigned only after an `await` inside the
      // frame handler, so two connections arriving before the first `hello`
      // lands both passed the check above; the second then overwrote the first's
      // in-flight session, defeating the "never evict a live session" guard
      // during the handshake window. `claiming` closes that race.
      if (this.claiming && this.claiming.readyState === WebSocket.OPEN) {
        ws.close(4000, 'Another client is already connecting');
        return;
      }
      this.claiming = ws;
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
      if (this.claiming === ws) this.claiming = null;
      // A pairing claim left behind makes every sibling wait out its stale
      // timeout before anyone can pair again.
      if (this.session?.ws === ws) {
        this.session.releasePairing?.();
        this.session.releasePairing = undefined;
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
        if (this.session && this.session.ws === ws) {
          return this.handleSessionFrame(frame);
        }

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

            const shared = await deriveSharedSecret(kp.privateKey, frame.ePub);
            const { handshakeKey, pairingSecret } = await deriveHandshakeKeys(
              shared,
              fromB64(frame.eNonce),
              fromB64(sNonce),
            );
            const sessionId = await computeSessionId(frame.ePub, kp.publicKeyB64, frame.eNonce, sNonce);
            const serverId = getServerId();
            const known = getPeer(frame.extId, serverId);

            this.session = {
              ws,
              state: known ? 'auth' : 'pairing',
              extId: frame.extId,
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
            // The slot is now held by a real session; release the accept-time
            // reservation.
            if (this.claiming === ws) this.claiming = null;

            const session = this.session;

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
            const claim = await claimPairing(frame.extId, serverId, PAIRING_CLAIM_BUDGET_MS);
            // The peer can disconnect while we wait on a sibling's prompt.
            if (this.session !== session || ws.readyState !== WebSocket.OPEN) {
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
              session.state = 'auth';
              return this.sendChallenge(session);
            }
            if (!claim.pair) {
              return fail(
                'another onbridge server is pairing with this browser; retry in a moment',
              );
            }

            session.releasePairing = claim.release;
            await this.sendSealed(session.handshakeKey, {
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

    ws.on('close', () => {
      // A socket that closes mid-handshake never became `this.session`, so
      // `teardown` is a no-op for it — but it must still release the accept-time
      // reservation, or a peer that connects and drops before `hello` would lock
      // out every later connection.
      if (this.claiming === ws) this.claiming = null;
      this.teardown(ws);
    });
    ws.on('error', (err) => this.log(`socket error: ${err.message}`));
  }

  private async sendChallenge(s: Session): Promise<void> {
    const nonce = toB64(randomBytes(16));
    s.challengeNonce = nonce;
    await this.sendSealed(s.handshakeKey, {
      t: 'challenge',
      nonce,
      agent: this.agentIdentity(),
    });
  }

  /** Frames after `hello`: sealed under the handshake key, then the session key. */
  private async handleSessionFrame(frame: HandshakeFrame): Promise<void> {
    const s = this.session!;
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

    if (s.state === 'ready') return this.handleMessage(inner as ExtensionMessage);

    const hs = inner as HandshakeFrame;

    if (s.state === 'pairing') {
      if (hs.t === 'pair_denied') return fail('user denied pairing');
      if (hs.t !== 'pair_confirm') return fail(`expected pair_confirm, got ${hs.t}`);
      if (!(await verifyProof(s.pairingSecret, PROOF_PAIR, s.sessionId, '', hs.proof))) {
        return fail('invalid pairing proof');
      }
      const serverId = getServerId();
      if (s.resetRequested) forgetPeer(s.extId, serverId);
      savePeer(s.extId, serverId, toB64(s.pairingSecret));
      this.log(`paired with extension ${s.extId}`);
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
        this.log(`peer ${s.extId} requested pairing reset`);
        const { pairingSecret } = await deriveHandshakeKeys(s.shared, s.eNonce, s.sNonce);
        if (this.session !== s) return;
        s.pairingSecret = pairingSecret;
        s.state = 'pairing';
        // Take the pairing claim for this one too. A reset is a pairing, and a
        // sibling starting one in parallel would clobber it the same way.
        const claim = await claimPairing(s.extId, getServerId(), PAIRING_CLAIM_BUDGET_MS);
        if (this.session !== s || s.ws.readyState !== WebSocket.OPEN) {
          claim.release();
          return;
        }
        // A record appearing while we waited belongs to a sibling's fresh
        // pairing, not to the one being reset; the reset still has to run, so
        // the claim is taken regardless and only the wait mattered.
        s.releasePairing = claim.release;
        return this.sendSealed(s.handshakeKey, {
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
        await this.sendSealed(s.handshakeKey, {
          t: 'auth_fail',
          reason: 'invalid auth proof',
          evidence: {
            ...pairingEvidence(s.extId, getServerId()),
            siblingServers: this.siblingCount,
          },
        });
        return fail('invalid auth proof');
      }

      // Mutual: prove to the extension that we hold the pairing secret too, so a
      // rogue local server cannot impersonate a previously paired agent.
      await this.sendSealed(s.handshakeKey, {
        t: 'auth_ok',
        proof: await makeProof(s.pairingSecret, PROOF_AUTH_SRV, s.sessionId, s.challengeNonce ?? ''),
      });
      // Forced: this is a real authentication, and it is the event that makes
      // `lastSeen` mean something. Heartbeats touch it too, throttled.
      touchPeer(s.extId, getServerId(), true);
      return this.promote(s);
    }
  }

  /**
   * Takes the session explicitly and re-checks it after every await. A peer that
   * disconnects mid-promotion used to null `this.session` under us and take the
   * whole process down with a TypeError — a one-line local denial of service.
   */
  private async promote(s: Session): Promise<void> {
    clearTimeout(s.timer);
    // Bound to BOTH the ephemeral ECDH output (forward secrecy: stealing the
    // stored pairing secret later does not decrypt a capture from today) and the
    // pairing secret (a peer without it derives a different key, so every frame
    // it sends fails to decrypt).
    const sessionKey = await deriveSessionKey(s.shared, s.pairingSecret, s.eNonce, s.sNonce);
    if (this.session !== s) return; // peer went away mid-handshake

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

  private sendSealed(key: CryptoKey, payload: HandshakeFrame | ServerMessage): Promise<void> {
    const s = this.session;
    if (!s) return Promise.resolve();
    // Grab the counter synchronously so frames are numbered in call order, then
    // chain the async seal+send so they also reach the wire in that order.
    const counter = s.txCounter++;
    const data = JSON.stringify(payload);
    s.sendChain = s.sendChain.then(async () => {
      const sealed = await seal(key, counter, data);
      // The session may have been replaced or closed while this waited its turn.
      if (this.session === s && s.ws.readyState === WebSocket.OPEN) {
        s.ws.send(JSON.stringify({ t: 'enc', ...sealed }));
      }
    });
    return s.sendChain;
  }

  private teardown(ws: WebSocket): void {
    if (this.session?.ws !== ws) return;
    clearTimeout(this.session.timer);
    // A peer that vanishes mid-prompt must not leave siblings queued behind a
    // lock nobody will ever release.
    this.session.releasePairing?.();
    this.session = null;
    this.stopHeartbeat();
    this.log('extension disconnected');
    for (const [id, cmd] of this.pending) {
      cmd.reject(commandError('Extension disconnected', true));
      clearTimeout(cmd.timer);
      this.pending.delete(id);
    }
  }

  isConnected(): boolean {
    return this.session?.state === 'ready' && this.session.ws.readyState === WebSocket.OPEN;
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
    if (!this.isConnected()) {
      throw commandError(
        'Extension not connected. Enable control mode in the onbridge browser extension.',
        true,
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

      this.pending.set(id, { resolve, reject, timer });
      void this.sendSealed(this.session!.sessionKey!, msg);
    });
  }

  private handleMessage(msg: ExtensionMessage): void {
    switch (msg.type) {
      case 'ready':
        this.log(`extension ready: v${msg.version}`);
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
      if (!this.isConnected()) return;
      void this.sendSealed(this.session!.sessionKey!, { type: 'ping' });
      // Keeps `lastSeen` honest for the life of a long session. Throttled
      // inside `touchPeer`, so this is not a file write every fifteen seconds.
      touchPeer(this.session!.extId, getServerId());
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
    this.session?.ws.close();
    this.wss?.close();
  }
}
