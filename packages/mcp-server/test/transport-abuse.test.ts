/**
 * The transport's answer to a hostile local peer.
 *
 * The Origin check keeps web pages out, and that is the attack it was designed
 * for. It is not the whole story: anything else on the machine can set an Origin
 * header, and the `pair_confirm` proof a peer sends is derived from the key
 * exchange it just performed — so it proves the peer did ECDH, never that a
 * human approved anything. These tests cover what stands in for that missing
 * consent signal: binding the claimed extension id to the connection, and
 * pinning the first extension we pair with.
 *
 * Each of these was a working attack. If one starts passing for the wrong
 * reason, a rogue local process can drive the user's browser.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HANDSHAKE_VERSION,
  PROOF_PAIR,
  computeSessionId,
  deriveHandshakeKeys,
  deriveSharedSecret,
  generateEphemeralKeyPair,
  fromB64,
  makeProof,
  open as openFrame,
  randomBytes,
  seal,
  toB64,
} from '@onbridge/shared';
import { checkPeerIdentity } from '../src/identity.js';
import {
  startServer,
  waitForListening,
  getPort,
  openSession,
  EXT_ID,
  EXT_ORIGIN,
  type Harness,
} from './session-helper.js';

let h: Harness;

beforeAll(async () => {
  h = startServer();
  await h.rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1' },
  });
  await waitForListening();
}, 30_000);

afterAll(() => h?.stop());

const settle = () => new Promise((r) => setTimeout(r, 500));

function peers(): Record<string, { pairingSecret: string }> {
  try {
    return JSON.parse(readFileSync(join(h.home, 'peers.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * A peer that will pair itself given the chance: it computes its own
 * `pair_confirm` proof and never consults a user, because nothing in the
 * protocol requires it to.
 */
async function selfPairingPeer(origin: string, extId: string, autoPair = true) {
  const ws = await new Promise<WebSocket>((res, rej) => {
    const s = new WebSocket(`ws://127.0.0.1:${getPort()}`, { origin });
    s.once('open', () => res(s));
    s.once('error', rej);
    setTimeout(() => rej(new Error('connect timeout')), 4000);
  });

  const kp = await generateEphemeralKeyPair();
  const eNonce = toB64(randomBytes(16));
  const st: Record<string, any> = {};
  let tx = 0;

  const outcome = new Promise<{ paired: boolean; reason: string }>((resolve) => {
    ws.once('close', (code, reason) =>
      resolve({ paired: Boolean(st.paired), reason: String(reason) || `code ${code}` }),
    );
    ws.on('message', (raw) => {
      void (async () => {
        // Anything unparseable or undecryptable here means the server refused us
        // in some way this probe does not model; the close reason is the result
        // we actually assert on, so never let it surface as an unhandled reject.
        const f = JSON.parse(raw.toString());
        if (f.t === 'hello_ack') {
          st.shared = await deriveSharedSecret(kp.privateKey, f.sPub);
          st.sNonce = fromB64(f.sNonce);
          const d = await deriveHandshakeKeys(st.shared, fromB64(eNonce), st.sNonce);
          st.hsKey = d.handshakeKey;
          st.pair = d.pairingSecret;
          st.sessionId = await computeSessionId(kp.publicKeyB64, f.sPub, eNonce, f.sNonce);
          return;
        }
        if (f.t !== 'enc' || !st.hsKey) return;
        const inner = JSON.parse(await openFrame(st.hsKey, f));
        if (inner.t === 'pair_required') {
          if (!autoPair) return void resolve({ paired: false, reason: 'offered pairing' });
          st.paired = true;
          const sealed = await seal(
            st.hsKey,
            tx++,
            JSON.stringify({ t: 'pair_confirm', proof: await makeProof(st.pair, PROOF_PAIR, st.sessionId) }),
          );
          ws.send(JSON.stringify({ t: 'enc', ...sealed }));
          resolve({ paired: true, reason: '' });
        }
      })().catch(() => resolve({ paired: false, reason: 'channel failed' }));
    });
  });

  ws.send(JSON.stringify({ t: 'hello', v: HANDSHAKE_VERSION, extId, ePub: kp.publicKeyB64, eNonce }));

  const sendHs = async (payload: unknown) => {
    const sealed = await seal(st.hsKey, tx++, JSON.stringify(payload));
    ws.send(JSON.stringify({ t: 'enc', ...sealed }));
  };
  const close = () =>
    new Promise<void>((r) => {
      if (ws.readyState === WebSocket.CLOSED) return void setTimeout(r, 150);
      ws.once('close', () => setTimeout(r, 150));
      ws.close();
    });

  return { ws, outcome, sendHs, close };
}

describe('hostile local peer', () => {
  it('refuses an extension id that does not match the connection origin', async () => {
    // Claiming someone else's id is the whole attack: it is what lets a rogue
    // aim `pair_reset` at a victim's record and then re-pair over it.
    const p = await selfPairingPeer('chrome-extension://rogueextensionid', EXT_ID);
    const { paired, reason } = await p.outcome;
    expect(paired).toBe(false);
    expect(reason).toMatch(/does not match the connection origin/);
    expect(peers()).not.toHaveProperty(EXT_ID);
    await p.close();
  });

  // Order matters from here: this case establishes the pin that the next two
  // depend on. Vitest runs cases in file order, so they are correct as written —
  // but do not reorder them or split them into separate files.
  it('pairs the first extension it meets', async () => {
    const s = await openSession();
    await settle();
    expect(peers()).toHaveProperty(EXT_ID);
    await s.close();
    await settle();
  });

  it('refuses a second, different extension once one is pinned', async () => {
    // Consistent origin and id this time — a real second extension, not a
    // spoof. Trust-on-first-use is what stops it enrolling itself.
    const p = await selfPairingPeer('chrome-extension://rogueextensionid', 'rogueextensionid');
    const { paired, reason } = await p.outcome;
    expect(paired).toBe(false);
    expect(reason).toMatch(/paired with a different extension/);
    expect(peers()).not.toHaveProperty('rogueextensionid');
    await p.close();
    await settle();
  });

  it('keeps the pairing record when a peer asks to reset and then vanishes', async () => {
    const before = peers()[EXT_ID].pairingSecret;

    // Reconnects as the legitimate extension, asks to re-pair, then drops the
    // socket without completing one. Dropping the record at request time made
    // this a one-frame way to lock the real extension out permanently.
    const p = await selfPairingPeer(EXT_ORIGIN, EXT_ID, false);
    await settle();
    await p.sendHs({ t: 'pair_reset' });
    await settle();
    await p.close();
    await settle();

    expect(peers()[EXT_ID]?.pairingSecret).toBe(before);
  });

  /**
   * The boundary of what the transport can promise, written down.
   *
   * A peer that impersonates the *pinned* extension id — ids are public, and a
   * local program can present any Origin — can still reset the pairing and pair
   * itself, because the server has no way to observe that a human approved
   * anything. A loopback TCP socket carries no proof of which process is on the
   * other end, so this cannot be closed here.
   *
   * It is asserted rather than left implicit so that closing it later fails this
   * test and forces the README's honesty note to be revisited with it.
   */
  it('cannot stop a peer that impersonates the pinned id (known limitation)', async () => {
    const before = peers()[EXT_ID].pairingSecret;

    const p = await selfPairingPeer(EXT_ORIGIN, EXT_ID);
    try {
      await settle();
      await p.sendHs({ t: 'pair_reset' });
      await p.outcome; // it is offered pairing, and confirms it itself
      await settle();

      // The record is now the impostor's. No human was asked at any point.
      expect(peers()[EXT_ID].pairingSecret).not.toBe(before);
    } finally {
      await p.close();
      await settle();
    }

    // What the extension has to work with: its stored secret stops being
    // accepted, which is the trace it surfaces instead of silently re-pairing.
  });
});

describe('peer identity checks', () => {
  it('refuses a connection with no usable extension origin', () => {
    // Unreachable while `verifyClient` demands a chrome-extension:// origin, but
    // the two checks sit far apart; a peer with no origin must never fall
    // through to being trusted on the id it named for itself.
    expect(checkPeerIdentity('someid', undefined)).toMatch(/no usable/);
    expect(checkPeerIdentity('someid', 'https://evil.test')).toMatch(/no usable/);
  });

  it('refuses an id that disagrees with the origin', () => {
    expect(checkPeerIdentity('aaaa', 'chrome-extension://bbbb')).toMatch(/does not match/);
  });
});
