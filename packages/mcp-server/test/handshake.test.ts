/**
 * End-to-end security tests for the onbridge secure channel.
 *
 * These drive the REAL server binary over a REAL socket, with the extension side
 * simulated using the same shared crypto the extension itself uses. They are the
 * evidence behind the security claims in the README — if one of these fails, a
 * claim we make in public is false.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
} from '@onbridge/shared';
import type { AgentIdentity } from '@onbridge/shared';

const EXT_ID = 'testextensionid';
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));

let srv: ChildProcess;
let home: string;
let port = 0;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'onbridge-test-'));
  srv = spawn('node', [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ONBRIDGE_HOME: home },
  });
  srv.stderr!.on('data', (d) => {
    const text = String(d);
    // Capture the port the server actually bound. The bridge scans 9876-9885,
    // so assuming 9876 makes the suite talk to whatever else already holds it
    // and fail with "invalid auth proof" — a crypto-looking error that is not.
    const m = /listening on 127\.0\.0\.1:(\d+)/.exec(text);
    if (m) port = Number(m[1]);
    if (process.env.ONBRIDGE_TEST_VERBOSE) process.stderr.write(`[srv] ${text}`);
  });
  srv.on('exit', (code, sig) => {
    if (process.env.ONBRIDGE_TEST_VERBOSE) process.stderr.write(`[srv] EXITED code=${code} sig=${sig}\n`);
  });
  // serveStdio only builds the server (and therefore the Bridge) on `initialize`,
  // so without this handshake there is no listener at all.
  srv.stdin!.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '1' },
      },
    }) + '\n',
  );
  await waitForPort();
});

afterAll(() => {
  srv?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function waitForPort(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (port) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!port) throw new Error('server never reported a listening port');

  for (let i = 0; i < 60; i++) {
    try {
      const ws = await connect(EXT_ORIGIN);
      ws.close();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('server never started listening');
}

/**
 * Closes and waits for the server to actually release its single session slot.
 * Without this the next connect races the previous close and gets rejected with
 * "Another client is already connected".
 */
async function closeAndSettle(ws: WebSocket): Promise<void> {
  const closed = new Promise<void>((r) => ws.once('close', () => r()));
  ws.close();
  await closed;
  await new Promise((r) => setTimeout(r, 150));
}

function connect(origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = origin
      ? new WebSocket(`ws://127.0.0.1:${port}`, { origin })
      : new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('timeout')), 4000);
  });
}

interface HsResult {
  paired: boolean;
  serverId: string;
  pairingSecret: Uint8Array;
  serverProofValid?: boolean;
  denied?: boolean;
  /** Who the server says is driving it. Shown to the user before they approve. */
  agent?: AgentIdentity;
}

/** Runs the extension half of the handshake. */
function handshake(
  ws: WebSocket,
  opts: { pairingSecret?: Uint8Array; allow: boolean },
): Promise<HsResult> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const kp = await generateEphemeralKeyPair();
      const eNonce = toB64(randomBytes(16));
      let tx = 0;
      const st: Record<string, any> = {};

      const sendSealed = async (key: CryptoKey, payload: unknown) => {
        const s = await seal(key, tx++, JSON.stringify(payload));
        ws.send(JSON.stringify({ t: 'enc', ...s }));
      };

      const timer = setTimeout(() => reject(new Error('handshake timeout')), 10_000);
      ws.on('close', (c, r) => reject(new Error(`closed ${c} ${r.toString()}`)));

      // Strictly serialised: hello_ack derives the keys the next frame needs.
      let q: Promise<void> = Promise.resolve();
      ws.on('message', (raw) => {
        q = q.then(async () => {
          try {
            const frame = JSON.parse(raw.toString());

            if (frame.t === 'hello_ack') {
              st.shared = await deriveSharedSecret(kp.privateKey, frame.sPub);
              st.sNonce = fromB64(frame.sNonce);
              const d = await deriveHandshakeKeys(st.shared, fromB64(eNonce), st.sNonce);
              st.hsKey = d.handshakeKey;
              st.pair = opts.pairingSecret ?? d.pairingSecret;
              st.sessionId = await computeSessionId(
                kp.publicKeyB64,
                frame.sPub,
                eNonce,
                frame.sNonce,
              );
              st.serverId = frame.serverId;
              st.paired = frame.paired;
              return;
            }
            if (frame.t !== 'enc') return;

            const inner = JSON.parse(await openFrame(st.ready ? st.sessionKey : st.hsKey, frame));

            if (inner.t === 'pair_required') {
              st.agent = inner.agent;
              if (!opts.allow) {
                await sendSealed(st.hsKey, { t: 'pair_denied' });
                clearTimeout(timer);
                return resolve({ ...(st as any), denied: true });
              }
              await sendSealed(st.hsKey, {
                t: 'pair_confirm',
                proof: await makeProof(st.pair, PROOF_PAIR, st.sessionId),
              });
              st.sessionKey = await deriveSessionKey(st.shared, st.pair, fromB64(eNonce), st.sNonce);
              st.ready = true;
              clearTimeout(timer);
              return resolve({
                paired: st.paired,
                serverId: st.serverId,
                pairingSecret: st.pair,
                agent: st.agent,
              });
            }

            if (inner.t === 'challenge') {
              st.challenge = inner.nonce;
              st.agent = inner.agent;
              await sendSealed(st.hsKey, {
                t: 'auth',
                proof: await makeProof(st.pair, PROOF_AUTH_EXT, st.sessionId, inner.nonce),
              });
              return;
            }

            if (inner.t === 'auth_ok') {
              const valid = await verifyProof(
                st.pair,
                PROOF_AUTH_SRV,
                st.sessionId,
                st.challenge,
                inner.proof,
              );
              st.sessionKey = await deriveSessionKey(st.shared, st.pair, fromB64(eNonce), st.sNonce);
              st.ready = true;
              clearTimeout(timer);
              return resolve({
                paired: st.paired,
                serverId: st.serverId,
                pairingSecret: st.pair,
                serverProofValid: valid,
                agent: st.agent,
              });
            }
          } catch (e) {
            clearTimeout(timer);
            reject(e);
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
        }),
      );
    })();
  });
}

describe('origin policy', () => {
  it('rejects a web page origin', async () => {
    // The critical claim: WebSockets bypass CORS, so any site the user visits can
    // reach 127.0.0.1. This is what stops it.
    await expect(connect('https://evil.example.com')).rejects.toThrow();
  });

  it('rejects a connection with no origin header', async () => {
    await expect(connect(undefined)).rejects.toThrow();
  });

  it('accepts an extension origin', async () => {
    const ws = await connect(EXT_ORIGIN);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await closeAndSettle(ws);
  });
});

describe('pairing lifecycle', () => {
  let secret: Uint8Array;

  it('requires pairing on first run', async () => {
    const ws = await connect(EXT_ORIGIN);
    const r = await handshake(ws, { allow: true });
    expect(r.paired).toBe(false);
    secret = r.pairingSecret;
    await closeAndSettle(ws);
  });

  it('authenticates silently on later runs', async () => {
    // The entire low-friction claim rests on this: pair once, then never again.
    const ws = await connect(EXT_ORIGIN);
    const r = await handshake(ws, { pairingSecret: secret, allow: false });
    expect(r.paired).toBe(true);
    await closeAndSettle(ws);
  });

  it('proves the server also holds the pairing secret (mutual auth)', async () => {
    // Without this a rogue local server could impersonate a paired agent.
    const ws = await connect(EXT_ORIGIN);
    const r = await handshake(ws, { pairingSecret: secret, allow: false });
    expect(r.serverProofValid).toBe(true);
    await closeAndSettle(ws);
  });

  it('names the agent in the pairing prompt', async () => {
    // "An AI agent wants to control your browser" is not a prompt anyone can
    // make a decision about, and it is the only thing standing between a user
    // and handing over their logged-in browser.
    const ws = await connect(EXT_ORIGIN);
    const r = await handshake(ws, { pairingSecret: secret, allow: false });
    expect(r.agent).toBeDefined();
    // The test harness introduces itself as "vitest" over MCP `initialize`.
    expect(r.agent!.name).toBe('Vitest');
    expect(r.agent!.source).toBe('mcp');
    expect(r.agent!.pid).toBeGreaterThan(0);
    expect(r.agent!.cwd).toBeTruthy();
    expect(r.agent!.port).toBe(port);
    await closeAndSettle(ws);
  });

  it('rejects a peer holding the wrong pairing secret', async () => {
    // The socket must open first, so a dead server cannot masquerade as a pass.
    const ws = await connect(EXT_ORIGIN);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await expect(handshake(ws, { pairingSecret: randomBytes(32), allow: false })).rejects.toThrow();
  });
});
