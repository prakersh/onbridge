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
import { spawn } from 'node:child_process';
import { WS_PORT_RANGE } from '@onbridge/shared';
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
  serverPortRange,
  makeOriginCheck,
  OFFICIAL_EXTENSION_ID,
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

describe('the port range a server binds', () => {
  const saved = process.env.ONBRIDGE_PORT_BASE;
  afterEach(() => {
    if (saved === undefined) delete process.env.ONBRIDGE_PORT_BASE;
    else process.env.ONBRIDGE_PORT_BASE = saved;
  });

  it('is the range the extension scans when nothing moves it', () => {
    delete process.env.ONBRIDGE_PORT_BASE;
    expect(serverPortRange()).toEqual(WS_PORT_RANGE);
  });

  // The test suites rely on this: their servers must be unreachable from a contributor's real browser.
  it('moves the whole range, same size, clear of the one the extension scans', () => {
    process.env.ONBRIDGE_PORT_BASE = '19876';
    const range = serverPortRange();
    expect(range).toHaveLength(WS_PORT_RANGE.length);
    expect(range[0]).toBe(19876);
    expect(range.some((p) => WS_PORT_RANGE.includes(p))).toBe(false);
  });

  it('ignores a value that is not a usable port', () => {
    for (const bad of ['abc', '80', '65530', '9876.5']) {
      process.env.ONBRIDGE_PORT_BASE = bad;
      expect(serverPortRange()).toEqual(WS_PORT_RANGE);
    }
  });

  it('is what the test suites run with', () => {
    expect(saved).toBe('19876');
  });
});

describe('which extensions may connect', () => {
  const keys = ['ONBRIDGE_ALLOW_ANY_EXTENSION', 'ONBRIDGE_EXTENSION_ID', 'ONBRIDGE_DEV_EXTENSION_IDS'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const official = `chrome-extension://${OFFICIAL_EXTENSION_ID}`;
  const other = 'chrome-extension://someotherextension';
  const logs: string[] = [];
  const check = () => makeOriginCheck((m) => logs.push(m));

  beforeEach(() => {
    for (const k of keys) delete process.env[k];
    logs.length = 0;
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // A user who copies the shortest config must still be protected: with no list, whichever extension connects first is pinned.
  it('accepts only the official extension when nothing is configured', () => {
    const allowed = check();
    expect(allowed(official)).toBe(true);
    expect(allowed(other)).toBe(false);
    expect(allowed('https://example.com')).toBe(false);
    expect(checkPeerIdentity('someotherextension', other)).toBeNull(); // the id list decides, not pinning
  });

  it('accepts a different id instead when ONBRIDGE_EXTENSION_ID names one', () => {
    process.env.ONBRIDGE_EXTENSION_ID = 'someotherextension';
    const allowed = check();
    expect(allowed(other)).toBe(true);
    expect(allowed(official)).toBe(false);
  });

  it('accepts any extension, never a web page, in development mode, and says so', () => {
    process.env.ONBRIDGE_ALLOW_ANY_EXTENSION = '1';
    const allowed = check();
    expect(allowed(official)).toBe(true);
    expect(allowed(other)).toBe(true);
    expect(allowed('https://example.com')).toBe(false);
    expect(allowed(undefined)).toBe(false);
    expect(logs.join('\n')).toMatch(/ONBRIDGE_ALLOW_ANY_EXTENSION/);
  });

  it('does not treat a value other than 1 as development mode', () => {
    process.env.ONBRIDGE_ALLOW_ANY_EXTENSION = 'true';
    expect(check()(other)).toBe(false);
  });
});

describe('the peer store on disk', () => {
  // Other servers read it without taking the lock. A write that truncated the file first let one of them read it empty, conclude it had no pairing, and prompt for one it had.
  it('is never seen half-written by a reader in another process', async () => {
    const file = join(home, 'peers.json');
    savePeer(EXT, SRV_A, 'YQ==');
    const reader = spawn(process.execPath, [
      '-e',
      `const fs = require('fs'); let bad = 0, n = 0; const end = Date.now() + 1500;
       while (Date.now() < end) { try { JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8')); n++; } catch (e) { if (e.code !== 'ENOENT') bad++; } }
       process.stdout.write(JSON.stringify({ bad, n }));`,
    ]);
    let out = '';
    reader.stdout.on('data', (d) => (out += d));
    const done = new Promise((r) => reader.on('close', r));
    const end = Date.now() + 1400;
    let i = 0;
    while (Date.now() < end) {
      savePeer(EXT, `${SRV_A}-${i++ % 50}`, 'YQ==');
      await new Promise((r) => setImmediate(r));
    }
    await done;
    const { bad, n } = JSON.parse(out);
    expect(n).toBeGreaterThan(100);
    expect(bad).toBe(0);
  });
});

