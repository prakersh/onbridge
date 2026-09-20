/**
 * Two agents starting at the same moment against one browser.
 *
 * This is the scenario that produced both reported pairing defects, and it is
 * not exotic — it is what a *user-scope* MCP install does by default. One line
 * in `~/.claude.json` means every editor session spawns its own onbridge
 * server; six were live on the machine that reported this. They all bind
 * different ports and all share one `~/.onbridge`.
 *
 * Before the fix: each server saw an empty store, each asked the user to pair
 * (the "another session is trying to connect" storm), each derived a different
 * secret, and the two stores were written independently — so the browser could
 * end up holding secret B while the file held secret A. Every later handshake
 * then failed `invalid auth proof`, with no recovery anywhere in the UI.
 *
 * After: exactly one approval is asked for, and every server ends up
 * authenticated against the same record.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const EXT_ID = 'testextensionid';
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const homes: string[] = [];
const procs: ChildProcess[] = [];

afterAll(() => {
  for (const p of procs) p.kill();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

/** Starts a server against a given `~/.onbridge` and waits for its port. */
async function startServer(home: string, name: string): Promise<number> {
  const proc = spawn('node', [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ONBRIDGE_HOME: home, ONBRIDGE_AGENT_NAME: name },
  });
  procs.push(proc);

  let port = 0;
  proc.stderr!.on('data', (d) => {
    const text = String(d);
    const m = /listening on 127\.0\.0\.1:(\d+)/.exec(text);
    if (m) port = Number(m[1]);
    if (process.env.ONBRIDGE_TEST_VERBOSE) process.stderr.write(`[${name}] ${text}`);
  });
  // The MCP transport has to be alive or the process exits on stdin end.
  proc.stdin!.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name, version: '1' } },
    }) + '\n',
  );

  for (let i = 0; i < 100 && !port; i++) await sleep(100);
  if (!port) throw new Error(`${name} never reported a port`);
  return port;
}

/**
 * The browser side, shared across every server the way the real extension is:
 * one secret per server id, held in one place.
 */
interface FakeBrowser {
  /** Secrets by server id — the stand-in for `chrome.storage.local`. */
  secrets: Map<string, Uint8Array>;
  /** How many times the user was asked to approve a pairing. */
  prompts: number;
}

interface Dialled {
  ready: Promise<'paired' | 'authenticated'>;
  close(): Promise<void>;
}

/** Runs one full handshake against a port, exactly as the extension does. */
function dial(port: number, browser: FakeBrowser, approve = true): Dialled {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: EXT_ORIGIN });
  const st: Record<string, any> = {};
  let tx = 0;
  let settle!: (v: 'paired' | 'authenticated') => void;
  let fail!: (e: Error) => void;
  const ready = new Promise<'paired' | 'authenticated'>((res, rej) => {
    settle = res;
    fail = rej;
  });

  const send = async (payload: unknown) => {
    const sealed = await seal(st.hsKey, tx++, JSON.stringify(payload));
    ws.send(JSON.stringify({ t: 'enc', ...sealed }));
  };

  ws.on('close', (_code, reason) => fail(new Error(String(reason) || 'closed')));
  ws.on('error', (e) => fail(e));

  void (async () => {
    const kp = await generateEphemeralKeyPair();
    const eNonce = toB64(randomBytes(16));

    let q: Promise<void> = Promise.resolve();
    ws.on('message', (data) => {
      q = q
        .then(async () => {
          const frame = JSON.parse(data.toString());

          if (frame.t === 'hello_ack') {
            st.shared = await deriveSharedSecret(kp.privateKey, frame.sPub);
            st.sNonce = fromB64(frame.sNonce);
            const d = await deriveHandshakeKeys(st.shared, fromB64(eNonce), st.sNonce);
            st.hsKey = d.handshakeKey;
            st.derived = d.pairingSecret;
            st.serverId = frame.serverId;
            st.sessionId = await computeSessionId(kp.publicKeyB64, frame.sPub, eNonce, frame.sNonce);
            return;
          }
          if (frame.t !== 'enc') return;

          const inner = JSON.parse(await openFrame(st.hsKey, frame));

          if (inner.t === 'pair_required') {
            browser.prompts++;
            if (!approve) {
              await send({ t: 'pair_denied' });
              return;
            }
            // A pairing always uses the freshly derived secret; both sides
            // computed it from the same exchange without transmitting it.
            const secret = st.derived as Uint8Array;
            await send({ t: 'pair_confirm', proof: await makeProof(secret, PROOF_PAIR, st.sessionId) });
            browser.secrets.set(st.serverId, secret);
            settle('paired');
            return;
          }

          if (inner.t === 'challenge') {
            // The secret is chosen HERE, not at `hello_ack`: a server that saw
            // no record when it answered `hello` may find one a moment later,
            // written by the sibling that won the pairing claim.
            const secret = browser.secrets.get(st.serverId);
            if (!secret) throw new Error('challenged with no stored secret');
            await send({
              t: 'auth',
              proof: await makeProof(secret, PROOF_AUTH_EXT, st.sessionId, inner.nonce),
            });
            return;
          }

          if (inner.t === 'auth_ok') {
            settle('authenticated');
            return;
          }
          if (inner.t === 'auth_fail') throw new Error(`auth_fail: ${inner.reason}`);
        })
        .catch(fail);
    });

    await new Promise<void>((res) => (ws.readyState === WebSocket.OPEN ? res() : ws.once('open', () => res())));
    ws.send(
      JSON.stringify({ t: 'hello', v: HANDSHAKE_VERSION, extId: EXT_ID, ePub: kp.publicKeyB64, eNonce }),
    );
  })().catch(fail);

  return {
    ready,
    close: () =>
      new Promise<void>((res) => {
        if (ws.readyState === WebSocket.CLOSED) return void setTimeout(res, 100);
        ws.once('close', () => setTimeout(res, 100));
        ws.close();
      }),
  };
}

describe('two servers, one browser, one shared ~/.onbridge', () => {
  it('asks for one approval and leaves both servers usable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'onbridge-race-'));
    homes.push(home);

    const [portA, portB] = await Promise.all([
      startServer(home, 'Agent A'),
      startServer(home, 'Agent B'),
    ]);
    expect(portA).not.toBe(portB);

    const browser: FakeBrowser = { secrets: new Map(), prompts: 0 };

    // Both handshakes in flight at once, from an empty store. This is the race.
    const a = dial(portA, browser);
    const b = dial(portB, browser);
    const outcomes = await Promise.all([a.ready, b.ready]);

    // One prompt, not two: the second server waits for the first and then
    // authenticates against the record it wrote.
    expect(browser.prompts).toBe(1);
    expect(outcomes).toContain('paired');
    expect(outcomes).toContain('authenticated');

    // One secret on the browser side and one record on disk — and they agree.
    expect(browser.secrets.size).toBe(1);
    const store = JSON.parse(readFileSync(join(home, 'peers.json'), 'utf8'));
    expect(store.version).toBe(2);
    const records = Object.values(store.peers[EXT_ID] as Record<string, { pairingSecret: string }>);
    expect(records).toHaveLength(1);
    const [serverId, secret] = [...browser.secrets.entries()][0];
    expect(records[0].pairingSecret).toBe(toB64(secret));
    expect(store.peers[EXT_ID][serverId]).toBeDefined();

    await a.close();
    await b.close();
    await sleep(300);

    // The real regression: after the race, both must still authenticate. Before
    // the fix one of them held an orphaned secret and failed forever.
    const a2 = dial(portA, browser);
    expect(await a2.ready).toBe('authenticated');
    await a2.close();
    await sleep(200);

    const b2 = dial(portB, browser);
    expect(await b2.ready).toBe('authenticated');
    await b2.close();
    await sleep(200);

    // Still exactly one prompt: re-authenticating must never ask again.
    expect(browser.prompts).toBe(1);
  }, 60_000);

  it('advances lastSeen when a pairing is used again', async () => {
    const home = mkdtempSync(join(tmpdir(), 'onbridge-lastseen-'));
    homes.push(home);
    const port = await startServer(home, 'Agent C');
    const browser: FakeBrowser = { secrets: new Map(), prompts: 0 };

    const first = dial(port, browser);
    expect(await first.ready).toBe('paired');
    await first.close();
    await sleep(300);

    const read = () => {
      const store = JSON.parse(readFileSync(join(home, 'peers.json'), 'utf8'));
      return Object.values(store.peers[EXT_ID] as Record<string, { pairedAt: number; lastSeen: number }>)[0];
    };
    const afterPairing = read();

    await sleep(1_100);
    const second = dial(port, browser);
    expect(await second.ready).toBe('authenticated');
    await sleep(300);

    // It used to sit permanently equal to `pairedAt`, so it could not tell a
    // live pairing from one abandoned months ago — which is exactly what the
    // "was this record replaced?" question needs.
    expect(read().lastSeen).toBeGreaterThan(afterPairing.lastSeen);
    expect(read().pairedAt).toBe(afterPairing.pairedAt);

    await second.close();
  }, 60_000);
});
