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

export const EXT_ORIGIN = 'chrome-extension://testextensionid';
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

export function startServer(): Harness {
  const home = mkdtempSync(join(tmpdir(), 'onbridge-test-'));
  const proc = spawn('node', [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ONBRIDGE_HOME: home },
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
export async function openSession(): Promise<Session> {
  const ws = await connect(EXT_ORIGIN);
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
        st.pair = d.pairingSecret;
        st.sessionId = await computeSessionId(kp.publicKeyB64, frame.sPub, eNonce, frame.sNonce);
        return;
      }
      if (frame.t !== 'enc') return;

      const inner = JSON.parse(await openFrame(st.ready ? st.sessionKey : st.hsKey, frame));

      if (inner.t === 'pair_required') {
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
        await sendSealed(st.hsKey, {
          t: 'auth',
          proof: await makeProof(st.pair, PROOF_AUTH_EXT, st.sessionId, inner.nonce),
        });
        return;
      }

      // Established channel: service commands like the extension does.
      const msg = inner as ServerMessage;
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
          await sendSealed(st.sessionKey, {
            type: 'result',
            id: msg.id,
            success: false,
            data: null,
            error: (e as Error).message,
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
      extId: 'testext',
      ePub: kp.publicKeyB64,
      eNonce,
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
