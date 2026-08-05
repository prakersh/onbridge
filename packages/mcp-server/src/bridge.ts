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
import type { ServerMessage, ExtensionMessage, CommandAction, HandshakeFrame } from '@onbridge/shared';
import {
  buildAgentIdentity,
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
  txCounter: number;
  replay: ReplayGuard;
  timer: ReturnType<typeof setTimeout>;
}

export class Bridge {
  private wss: WebSocketServer | null = null;
  private session: Session | null = null;
  private pending = new Map<string, PendingCommand>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cmdCounter = 0;
  private port = 0;
  private isOriginAllowed = makeOriginCheck((m) => this.log(m));
  /** Notes typed in the side panel, awaiting delivery on the next tool result. */
  private userMessages: string[] = [];
  private startedAt = Date.now();
  private serverVersion = '0.0.0';
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
    this.wss!.on('connection', (ws) => {
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
      this.handleConnection(ws);
    });
  }

  /**
   * Not async: listeners must be attached synchronously. Generating the keypair
   * before subscribing left a window in which the client's `hello` — sent
   * immediately on open — arrived with no listener and was dropped, hanging the
   * handshake. The queue awaits `setup` instead, so frames are held, not lost.
   */
  private handleConnection(ws: WebSocket): void {
    const setup = (async () => ({
      kp: await generateEphemeralKeyPair(),
      sNonce: toB64(randomBytes(16)),
    }))();

    const fail = (reason: string) => {
      this.log(`handshake failed: ${reason}`);
      ws.close(4001, reason);
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

            const shared = await deriveSharedSecret(kp.privateKey, frame.ePub);
            const { handshakeKey, pairingSecret } = await deriveHandshakeKeys(
              shared,
              fromB64(frame.eNonce),
              fromB64(sNonce),
            );
            const sessionId = await computeSessionId(frame.ePub, kp.publicKeyB64, frame.eNonce, sNonce);
            const known = getPeer(frame.extId);

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
              timer: setTimeout(() => fail('handshake timed out'), HANDSHAKE_TIMEOUT_MS),
            };

            this.sendPlain(ws, {
              t: 'hello_ack',
              sPub: kp.publicKeyB64,
              sNonce,
              serverId: getServerId(),
              paired: Boolean(known),
            });

            if (known) {
              const nonce = toB64(randomBytes(16));
              this.session.challengeNonce = nonce;
              await this.sendSealed(this.session.handshakeKey, {
                t: 'challenge',
                nonce,
                agent: this.agentIdentity(),
              });
            } else {
              await this.sendSealed(this.session.handshakeKey, {
                t: 'pair_required',
                agent: this.agentIdentity(),
              });
            }
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
          ws.close(4002, 'internal error');
        } catch {
          /* already closed */
        }
      });
    });

    ws.on('close', () => this.teardown(ws));
    ws.on('error', (err) => this.log(`socket error: ${err.message}`));
  }

  /** Frames after `hello`: sealed under the handshake key, then the session key. */
  private async handleSessionFrame(frame: HandshakeFrame): Promise<void> {
    const s = this.session!;
    const fail = (reason: string) => {
      this.log(`session rejected: ${reason}`);
      s.ws.close(4001, reason);
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
      savePeer(s.extId, toB64(s.pairingSecret));
      this.log(`paired with extension ${s.extId}`);
      return this.promote(s);
    }

    if (s.state === 'auth') {
      // Extension lost its secret (typically a reinstall). Drop our record and
      // fall back to a fresh pairing, which the user must still approve.
      if (hs.t === 'pair_reset') {
        forgetPeer(s.extId);
        this.log(`peer ${s.extId} requested pairing reset`);
        const { pairingSecret } = await deriveHandshakeKeys(s.shared, s.eNonce, s.sNonce);
        s.pairingSecret = pairingSecret;
        s.state = 'pairing';
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
      if (!ok) return fail('invalid auth proof');

      // Mutual: prove to the extension that we hold the pairing secret too, so a
      // rogue local server cannot impersonate a previously paired agent.
      await this.sendSealed(s.handshakeKey, {
        t: 'auth_ok',
        proof: await makeProof(s.pairingSecret, PROOF_AUTH_SRV, s.sessionId, s.challengeNonce ?? ''),
      });
      touchPeer(s.extId);
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

  private sendPlain(ws: WebSocket, frame: HandshakeFrame): void {
    ws.send(JSON.stringify(frame));
  }

  private async sendSealed(key: CryptoKey, payload: HandshakeFrame | ServerMessage): Promise<void> {
    const s = this.session;
    if (!s) return;
    const sealed = await seal(key, s.txCounter++, JSON.stringify(payload));
    s.ws.send(JSON.stringify({ t: 'enc', ...sealed }));
  }

  private teardown(ws: WebSocket): void {
    if (this.session?.ws !== ws) return;
    clearTimeout(this.session.timer);
    this.session = null;
    this.stopHeartbeat();
    this.log('extension disconnected');
    for (const [id, cmd] of this.pending) {
      cmd.reject(new Error('Extension disconnected'));
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
   * Drains queued side-panel notes. Called when building a tool result: MCP has
   * no server-initiated channel into a running turn, so piggybacking on the next
   * result is the only way an unsolicited note reaches the agent.
   */
  takeUserMessages(): string[] {
    const out = this.userMessages;
    this.userMessages = [];
    return out;
  }

  async sendCommand(
    action: CommandAction,
    params: Record<string, unknown> = {},
    tabId?: number,
    timeoutMs: number = COMMAND_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.isConnected()) {
      throw new Error(
        'Extension not connected. Enable control mode in the onbridge browser extension.',
      );
    }

    const id = `cmd_${++this.cmdCounter}`;
    const msg: ServerMessage = { type: 'command', id, action, params };
    if (tabId != null) msg.tabId = tabId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command '${action}' timed out after ${timeoutMs}ms`));
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
        if (msg.success) cmd.resolve(msg.data);
        else cmd.reject(new Error(msg.error ?? 'Command failed'));
        break;
      }

      case 'event':
        if (msg.event === 'user_message') {
          const { text } = (msg.data ?? {}) as { text?: string };
          if (text?.trim()) this.userMessages.push(text.trim());
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
      if (this.isConnected()) void this.sendSealed(this.session!.sessionKey!, { type: 'ping' });
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
