/**
 * Test harness that plays the extension against the real server binary:
 * spawns it, drives MCP over stdio, and speaks the encrypted wire protocol.
 */

import { WebSocket } from 'ws';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HANDSHAKE_VERSION,
  PROOF_PAIR,
  PROOF_AUTH_EXT,
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
} from '@onbridge/shared';
import type { ExtensionMessage, ServerMessage } from '@onbridge/shared';

/**
 * The id and the origin must agree: the server binds the `extId` a peer claims
 * in `hello` to the Origin header Chrome set for it. A mismatch is a refusal.
 */
export const EXT_ID = 'testextensionid';
export const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));

/**
 * The port the server under test actually bound.
 *
 * Never assume 9876. The bridge scans 9876-9885, so if anything else already
 * holds the first port — a `pnpm dev` server, a previous run — our server binds
 * a later one. Hardcoding 9876 made the suite silently talk to that *other*
 * server and fail with "invalid auth proof", which looks like a crypto bug and
 * is not one.
 */
let boundPort = 0;

/**
 * Pairing secrets this process has established, keyed by server id — the test
 * stand-in for the extension's `chrome.storage.local`. Without it a reconnect
 * derives a brand new secret and fails auth against the stored one.
 */
const pairings = new Map<string, Uint8Array>();

/** Plays a browser updating to an extension that sends an install id: it keeps the pairing it made without one. */
export function adoptPairing(installId: string): void {
  for (const [slot, secret] of [...pairings]) {
    if (slot.startsWith('|')) pairings.set(`${installId}${slot}`, secret);
  }
}

/** Forgets stored pairings, so the next connection pairs from scratch. */
export function resetPairings(): void {
  pairings.clear();
}

export function getPort(): number {
  if (!boundPort) throw new Error('server has not reported a bound port yet');
  return boundPort;
}

export interface Harness {
  proc: ChildProcess;
  home: string;
  /** Sends a JSON-RPC request over stdio and resolves its response. */
  rpc(method: string, params?: unknown): Promise<any>;
  stop(): void;
}

/** `env` overrides the inherited environment; a key set to undefined is removed. */
export function startServer(env: Record<string, string | undefined> = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), 'onbridge-test-'));
  const merged: Record<string, string | undefined> = { ...process.env, ONBRIDGE_HOME: home, ...env };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  const proc = spawn('node', [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: merged as NodeJS.ProcessEnv,
  });

  proc.stderr!.on('data', (d) => {
    const text = String(d);
    // The bridge announces the port it actually bound; capture it rather than
    // assuming the first one in the range was free.
    const m = /listening on 127\.0\.0\.1:(\d+)/.exec(text);
    if (m) boundPort = Number(m[1]);
    if (process.env.ONBRIDGE_TEST_VERBOSE) process.stderr.write(`[srv] ${text}`);
  });

  let buf = '';
  const waiters = new Map<number, (v: any) => void>();
  proc.stdout!.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const w = waiters.get(msg.id);
        if (w) {
          waiters.delete(msg.id);
          w(msg);
        }
      } catch {
        /* not JSON-RPC */
      }
    }
  });

  let nextId = 1;
  const rpc = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      waiters.set(id, resolve);
      proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (waiters.delete(id)) reject(new Error(`rpc ${method} timed out`));
      }, 20_000);
    });

  return {
    proc,
    home,
    rpc,
    stop() {
      proc.kill();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export function connect(origin?: string): Promise<WebSocket> {
  const port = getPort();
  return new Promise((resolve, reject) => {
    const ws = origin
      ? new WebSocket(`ws://127.0.0.1:${port}`, { origin })
      : new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 4000);
  });
}

/** A paired, encrypted channel with the command loop running. */
export interface Session {
  ws: WebSocket;
  /** Registers the handler invoked for each command the server sends. */
  onCommand(fn: (action: string, params: any) => unknown | Promise<unknown>): void;
  /** Pushes an unsolicited extension->server event. */
  emit(msg: ExtensionMessage): Promise<void>;
  close(): Promise<void>;
}

/**
 * Completes pairing and then services commands, exactly as the extension does.
 */
/**
 * `installId` plays one browser profile's copy of the extension; omitted, the peer is an extension too old to send one. Stored pairings are kept per install, as each profile keeps its own.
 * `approve` plays the user at the pairing prompt: the pairing is confirmed when it resolves (immediately when omitted). `onSocket` hands over the socket before the handshake finishes, and `onServerMessage` sees every non-command message the server sends once connected.
 */
export async function openSession(
  opts: {
    installId?: string;
    approve?: Promise<unknown>;
    onSocket?: (ws: WebSocket) => void;
    onServerMessage?: (msg: ServerMessage) => void;
  } = {},
): Promise<Session> {
  const slot = (serverId: string) => `${opts.installId ?? ''}|${serverId}`;
  const ws = await connect(EXT_ORIGIN);
  opts.onSocket?.(ws);
  const kp = await generateEphemeralKeyPair();
  const eNonce = toB64(randomBytes(16));
  let tx = 0;
  let handler: ((action: string, params: any) => unknown | Promise<unknown>) | null = null;

  const st: Record<string, any> = {};
  let ready!: () => void;
  const readyPromise = new Promise<void>((r) => (ready = r));

  const sendSealed = async (key: CryptoKey, payload: unknown) => {
    const s = await seal(key, tx++, JSON.stringify(payload));
    ws.send(JSON.stringify({ t: 'enc', ...s }));
  };

  let q: Promise<void> = Promise.resolve();
  ws.on('message', (raw) => {
    q = q.then(async () => {
      const frame = JSON.parse(raw.toString());

      if (frame.t === 'hello_ack') {
        st.shared = await deriveSharedSecret(kp.privateKey, frame.sPub);
        st.sNonce = fromB64(frame.sNonce);
        const d = await deriveHandshakeKeys(st.shared, fromB64(eNonce), st.sNonce);
        st.hsKey = d.handshakeKey;
        st.serverId = frame.serverId;
        // Mirrors the extension: a fresh secret when pairing, the stored one
        // when re-authenticating. Deriving anew on a reconnect would fail auth,
        // because the server checks against what it saved at pairing time.
        st.derived = d.pairingSecret;
        st.stored = pairings.get(slot(frame.serverId));
        st.pair = st.stored ?? d.pairingSecret;
        st.sessionId = await computeSessionId(kp.publicKeyB64, frame.sPub, eNonce, frame.sNonce);
        return;
      }
      if (frame.t !== 'enc') return;

      const inner = JSON.parse(await openFrame(st.ready ? st.sessionKey : st.hsKey, frame));

      if (inner.t === 'pair_required') {
        if (opts.approve) await opts.approve;
        st.pair = st.derived; // pairing always uses the freshly derived secret
        pairings.set(slot(st.serverId), st.pair);
        await sendSealed(st.hsKey, {
          t: 'pair_confirm',
          proof: await makeProof(st.pair, PROOF_PAIR, st.sessionId),
        });
        st.sessionKey = await deriveSessionKey(st.shared, st.pair, fromB64(eNonce), st.sNonce);
        st.ready = true;
        tx = 0;
        ready();
        return;
      }

      if (inner.t === 'challenge') {
        // Mirrors the extension: a record it holds no secret for is asked to reset, not answered with a secret that cannot match.
        if (!st.stored) {
          await sendSealed(st.hsKey, { t: 'pair_reset' });
          return;
        }
        await sendSealed(st.hsKey, {
          t: 'auth',
          proof: await makeProof(st.pair, PROOF_AUTH_EXT, st.sessionId, inner.nonce),
        });
        return;
      }

      // Re-connecting to a server that already knows us. Resolving `ready` only
      // on the pairing path meant a second openSession() against the same server
      // hung forever, which reads as a server bug and is not one.
      if (inner.t === 'auth_ok') {
        st.sessionKey = await deriveSessionKey(st.shared, st.pair, fromB64(eNonce), st.sNonce);
        st.ready = true;
        tx = 0;
        ready();
        return;
      }

      // Established channel: service commands like the extension does.
      const msg = inner as ServerMessage;
      if (msg.type !== 'command') opts.onServerMessage?.(msg);
      if (msg.type === 'ping') {
        await sendSealed(st.sessionKey, { type: 'pong' });
        return;
      }
      if (msg.type === 'command') {
        const start = Date.now();
        try {
          const data = await handler?.(msg.action, msg.params);
          await sendSealed(st.sessionKey, {
            type: 'result',
            id: msg.id,
            success: true,
            data: data ?? {},
            timing: Date.now() - start,
          });
        } catch (e) {
          // Mirrors the extension: only errors it composed itself are marked, so
          // a handler can simulate a governance refusal as well as a page throw.
          const trusted = Boolean((e as { onbridgeTrusted?: boolean }).onbridgeTrusted);
          // A retryable condition travels as a code, not as English — see
          // `errorCode` in the protocol. Mirrored here so a handler can
          // simulate "the page was navigating" the way the extension sends it.
          const code = (e as { onbridgeCode?: string }).onbridgeCode;
          const retryAfterMs = (e as { onbridgeRetryAfterMs?: number }).onbridgeRetryAfterMs;
          await sendSealed(st.sessionKey, {
            type: 'result',
            id: msg.id,
            success: false,
            data: null,
            error: (e as Error).message,
            ...(trusted ? { errorKind: 'trusted' as const } : {}),
            ...(trusted && code ? { errorCode: code as never, retryAfterMs } : {}),
            timing: Date.now() - start,
          });
        }
      }
    });
  });

  ws.send(
    JSON.stringify({
      t: 'hello',
      v: HANDSHAKE_VERSION,
      extId: EXT_ID,
      ePub: kp.publicKeyB64,
      eNonce,
      ...(opts.installId ? { installId: opts.installId } : {}),
    }),
  );

  await readyPromise;

  return {
    ws,
    onCommand(fn) {
      handler = fn;
    },
    async emit(msg) {
      await sendSealed(st.sessionKey, msg);
    },
    async close() {
      const closed = new Promise<void>((r) => ws.once('close', () => r()));
      ws.close();
      await closed;
      await new Promise((r) => setTimeout(r, 150));
    },
  };
}

/**
 * Waits until the server considers the encrypted channel usable.
 *
 * `openSession` resolves as soon as it has *sent* `pair_confirm`; the server
 * only becomes connected once it has processed that frame and derived the
 * session key. A tool called in that gap comes back "Extension not connected",
 * which looks like a tool bug and is a harness race.
 */
export async function waitForBridge(h: Harness): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const res = await h.rpc('tools/call', { name: 'bridge_status', arguments: {} });
    const body = (res.result?.content ?? []).map((c: any) => c.text ?? '').join('');
    if (!/not connected/i.test(body)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('bridge never reported a live session');
}

export async function waitForListening(): Promise<void> {
  // Wait for the server to report its port before attempting any connection.
  for (let i = 0; i < 100; i++) {
    if (boundPort) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!boundPort) throw new Error('server never reported a listening port');

  for (let i = 0; i < 60; i++) {
    try {
      const ws = await connect(EXT_ORIGIN);
      ws.close();
      await new Promise((r) => setTimeout(r, 100));
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`server never accepted a connection on ${boundPort}`);
}
