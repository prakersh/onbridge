/**
 * The peer store: what it is keyed by, what it can prove, and who may write it.
 *
 * This file exists because of a real dead end. Several agent sessions share one
 * `~/.onbridge`, the store was a flat `{extensionId: record}` map with no
 * locking, and a `forgetPeer` could only take everything. Started together
 * against an empty store, concurrent servers each derived their own secret and
 * the last writer on each side won *independently* — leaving the browser
 * holding one secret and the store another, which nothing in the protocol
 * recovers from.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimPairing,
  checkPeerIdentity,
  forgetPeer,
  getPeer,
  knownExtensionIds,
  pairingEvidence,
  peerRefusalHelp,
  savePeer,
  touchPeer,
} from '../src/identity.js';

let home: string;
const EXT = 'aaaaaaaaaaaaaaaa';
const SRV_A = 'server-a';
const SRV_B = 'server-b';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'onbridge-peers-'));
  process.env.ONBRIDGE_HOME = home;
});

afterEach(() => {
  delete process.env.ONBRIDGE_HOME;
  rmSync(home, { recursive: true, force: true });
});

const raw = () => JSON.parse(readFileSync(join(home, 'peers.json'), 'utf8'));

describe('the store honours ONBRIDGE_HOME set after import', () => {
  it('writes into the sandbox, not the real home', () => {
    // The path used to be captured in a module constant at import time, so a
    // test that set the variable afterwards wrote into the user's actual
    // `~/.onbridge`. A fixture extension id landing there is not cosmetic: any
    // stray entry keeps trust-on-first-use armed and refuses the user's own
    // extension.
    savePeer(EXT, SRV_A, 'c2VjcmV0');
    expect(existsSync(join(home, 'peers.json'))).toBe(true);
  });
});

describe('records are keyed by extension AND server', () => {
  it('keeps two servers apart under one extension', () => {
    savePeer(EXT, SRV_A, 'YQ==');
    savePeer(EXT, SRV_B, 'Yg==');
    expect(getPeer(EXT, SRV_A)?.pairingSecret).toBe('YQ==');
    expect(getPeer(EXT, SRV_B)?.pairingSecret).toBe('Yg==');
  });

  it('forgets exactly one pairing', () => {
    // The panel's "forget this agent and re-pair" must not take the others
    // down with it — that is the difference between a recovery and a reset.
    savePeer(EXT, SRV_A, 'YQ==');
    savePeer(EXT, SRV_B, 'Yg==');
    forgetPeer(EXT, SRV_A);
    expect(getPeer(EXT, SRV_A)).toBeUndefined();
    expect(getPeer(EXT, SRV_B)?.pairingSecret).toBe('Yg==');
    // The extension is still known, so trust-on-first-use still pins it.
    expect(knownExtensionIds()).toContain(EXT);
  });

  it('drops the extension once its last pairing is gone', () => {
    savePeer(EXT, SRV_A, 'YQ==');
    forgetPeer(EXT, SRV_A);
    expect(knownExtensionIds()).not.toContain(EXT);
  });
});

describe('an existing v1 store', () => {
  it('keeps working, filed under the server id that wrote it', () => {
    // Upgrading must not silently un-pair everybody.
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'server-key.json'), JSON.stringify({ serverId: SRV_A }));
    writeFileSync(
      join(home, 'peers.json'),
      JSON.stringify({ [EXT]: { pairingSecret: 'bGVnYWN5', pairedAt: 111, lastSeen: 111 } }),
    );

    expect(getPeer(EXT, SRV_A)?.pairingSecret).toBe('bGVnYWN5');
    expect(knownExtensionIds()).toEqual([EXT]);
  });

  it('is not rewritten until something else writes', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'server-key.json'), JSON.stringify({ serverId: SRV_A }));
    writeFileSync(
      join(home, 'peers.json'),
      JSON.stringify({ [EXT]: { pairingSecret: 'bGVnYWN5', pairedAt: 111, lastSeen: 111 } }),
    );
    getPeer(EXT, SRV_A);
    expect(raw().version).toBeUndefined();

    savePeer(EXT, SRV_B, 'bmV3');
    expect(raw().version).toBe(2);
    // …and the migrated record survived the upgrade.
    expect(getPeer(EXT, SRV_A)?.pairingSecret).toBe('bGVnYWN5');
  });
});

describe('lastSeen', () => {
  it('moves on a real authentication', async () => {
    // It used to sit permanently equal to `pairedAt`, which made it useless for
    // telling a live pairing from one left behind months ago — and that is the
    // one question the `invalid auth proof` prompt needs answered.
    savePeer(EXT, SRV_A, 'YQ==');
    const before = getPeer(EXT, SRV_A)!.lastSeen;
    await sleep(5);
    touchPeer(EXT, SRV_A, true);
    expect(getPeer(EXT, SRV_A)!.lastSeen).toBeGreaterThan(before);
  });

  it('is throttled when the heartbeat asks', async () => {
    // A file write every fifteen seconds for the life of a session is not a
    // trade worth making for minute-resolution freshness.
    savePeer('bbbbbbbbbbbbbbbb', SRV_A, 'YQ==');
    touchPeer('bbbbbbbbbbbbbbbb', SRV_A, true);
    const after = getPeer('bbbbbbbbbbbbbbbb', SRV_A)!.lastSeen;
    await sleep(5);
    touchPeer('bbbbbbbbbbbbbbbb', SRV_A); // unforced, inside the window
    expect(getPeer('bbbbbbbbbbbbbbbb', SRV_A)!.lastSeen).toBe(after);
  });
});

describe('pairing evidence', () => {
  it('reports the facts that separate a stale secret from a takeover', () => {
    savePeer(EXT, SRV_A, 'YQ==');
    const ev = pairingEvidence(EXT, SRV_A);
    expect(ev.pairedAt).toBeGreaterThan(0);
    expect(ev.lastSeen).toBeGreaterThan(0);
    expect(ev.storeWrittenAt).toBeGreaterThan(0);
    // Written at pairing time and not since: nothing replaced the record.
    expect(Math.abs(ev.storeWrittenAt! - ev.pairedAt!)).toBeLessThan(2_000);
  });
});

describe('claiming the right to pair', () => {
  it('gives it to the first caller', async () => {
    const first = await claimPairing(EXT, SRV_A, 500);
    expect(first.pair).toBe(true);
    first.release();
  });

  it('makes a sibling wait instead of starting a second pairing', async () => {
    const first = await claimPairing(EXT, SRV_A, 500);
    expect(first.pair).toBe(true);

    // The sibling cannot pair while the first prompt is open. Letting it would
    // recreate exactly the clobber this mechanism exists to prevent.
    const second = await claimPairing(EXT, SRV_A, 400);
    expect(second.pair).toBe(false);
    expect(second.record).toBeUndefined();
    expect(second.waited).toBe(true);

    first.release();
  });

  it('hands the sibling the record once the first pairing completes', async () => {
    const first = await claimPairing(EXT, SRV_A, 500);
    savePeer(EXT, SRV_A, 'c2hhcmVk');
    first.release();

    const second = await claimPairing(EXT, SRV_A, 500);
    expect(second.pair).toBe(false);
    expect(second.record?.pairingSecret).toBe('c2hhcmVk');
    expect(second.waited).toBe(false);
  });

  it('releases cleanly so the next pairing is not blocked', async () => {
    const abandoned = await claimPairing(EXT, SRV_A, 500);
    abandoned.release();
    const next = await claimPairing(EXT, SRV_A, 500);
    expect(next.pair).toBe(true);
    next.release();
  });
});

describe('recovery guidance', () => {
  it('says the whole file, because removing one entry makes it worse', () => {
    // The careful-looking thing to do with a map is to remove only your own
    // key. Any surviving key keeps trust-on-first-use armed, so the very
    // extension being repaired is then refused for a different reason.
    const help = peerRefusalHelp('zzzz');
    expect(help).toMatch(/whole|entire/i);
    expect(help).toMatch(/not just one entry/i);
    expect(help).toContain(home);
  });

  it('still pins the first extension it paired with', () => {
    savePeer(EXT, SRV_A, 'YQ==');
    expect(checkPeerIdentity(EXT, `chrome-extension://${EXT}`)).toBeNull();
    expect(checkPeerIdentity('bbbbbbbbbbbbbbbb', 'chrome-extension://bbbbbbbbbbbbbbbb')).toMatch(
      /different extension/,
    );
  });
});
