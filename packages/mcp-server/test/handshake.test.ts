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

const PORT = 9876;
const EXT_ORIGIN = 'chrome-extension://testextensionid';
const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));

let srv: ChildProcess;
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'onbridge-test-'));
  srv = spawn('node', [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ONBRIDGE_HOME: home },
  });
  srv.stderr!.on('data', (d) => {
    if (process.env.ONBRIDGE_TEST_VERBOSE) process.stderr.write(`[srv] ${d}`);
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
      ? new WebSocket(`ws://127.0.0.1:${PORT}`, { origin })
      : new WebSocket(`ws://127.0.0.1:${PORT}`);
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
              });
            }

            if (inner.t === 'challenge') {
              st.challenge = inner.nonce;
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
          extId: 'testext',
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

  it('rejects a peer holding the wrong pairing secret', async () => {
    // The socket must open first, so a dead server cannot masquerade as a pass.
    const ws = await connect(EXT_ORIGIN);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await expect(handshake(ws, { pairingSecret: randomBytes(32), allow: false })).rejects.toThrow();
  });
});
