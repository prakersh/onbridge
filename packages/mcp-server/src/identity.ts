/**
 * Persistent server identity and pairing records.
 *
 * The server identity exists for one reason: `npx onbridge` respawns the process
 * constantly, and without a stable id the extension would treat every run as a
 * new peer and re-prompt for pairing every single time. That would defeat the
 * whole "pair once, then one toggle forever" property.
 *
 * The id is an opaque random string, not a cryptographic claim. It is only a
 * lookup key for the pairing record. Authentication comes from the pairing
 * secret: an impostor that reuses someone else's id still cannot produce a valid
 * proof, and cannot derive the session key.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { WS_PORT_RANGE } from '@onbridge/shared';
import type { AgentIdentity, PairingEvidence } from '@onbridge/shared';

/**
 * ONBRIDGE_HOME lets tests point at a scratch dir instead of the real one.
 *
 * Resolved on every call rather than once at import. A module-level constant is
 * captured the instant anything imports this file, so a test that sets the
 * variable afterwards writes into the user's real `~/.onbridge` — which is how a
 * fixture extension id ended up in a real peer store, and how that store then
 * turned trust-on-first-use against the user's actual extension.
 */
function dir(): string {
  return process.env.ONBRIDGE_HOME || join(homedir(), '.onbridge');
}
const keyFile = () => join(dir(), 'server-key.json');
const peersFile = () => join(dir(), 'peers.json');

export interface PeerRecord {
  /** base64, 32 bytes. Derived during pairing, never transmitted. */
  pairingSecret: string;
  pairedAt: number;
  lastSeen: number;
}

/**
 * The on-disk peer store.
 *
 * Keyed by extension id *and* server id. One `~/.onbridge` holds one server id
 * today, so the second level usually has a single entry — but a flat
 * `{extId: record}` map made "which pairing is this?" unanswerable, and
 * `forgetPeer` an all-or-nothing operation. The panel's "forget this agent and
 * re-pair" has to drop exactly one pairing and leave the others alone, and that
 * needs a key that names one.
 */
interface PeerStore {
  version: 2;
  peers: Record<string, Record<string, PeerRecord>>;
}

function ensureDir(): void {
  const d = dir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonPrivate(path: string, value: unknown): void {
  ensureDir();
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  // `mode` on writeFileSync only applies when the file is created, so a file
  // that already existed keeps whatever permissions it had — including
  // world-readable ones from an older build. Re-assert them on every write.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort: a read-only home should not stop the server starting */
  }
}

/**
 * Cached for the life of the process, keyed by the directory it came from.
 *
 * Re-reading it per call was a live hazard, not an inefficiency. Two servers
 * starting together both found no key file, both generated an id, and both
 * wrote — so one process announced id X in its `hello_ack` and then, moments
 * later, read the *other* process's id back off disk and saved the pairing
 * record under that. The browser filed its secret under X and the record
 * existed under Y: an identity that changes mid-handshake produces exactly the
 * orphaned pairing this release is about. It must be read once and never move.
 */
let cachedServerId: string | undefined;
let cachedServerIdHome: string | undefined;

export function getServerId(): string {
  const home = dir();
  if (cachedServerId && cachedServerIdHome === home) return cachedServerId;

  // Created under a lock so concurrent first-runs converge on one id instead of
  // generating one each and letting the last write win.
  const serverId = withLock('server-key', () => {
    const existing = readJson<{ serverId?: string }>(keyFile(), {});
    if (existing.serverId) return existing.serverId;
    const fresh = randomBytes(16).toString('base64');
    writeJsonPrivate(keyFile(), { serverId: fresh, createdAt: Date.now() });
    return fresh;
  });

  cachedServerId = serverId;
  cachedServerIdHome = home;
  return serverId;
}

/**
 * Reads the store, upgrading a v1 file in memory.
 *
 * v1 was `{extId: PeerRecord}`. Every record in such a file was necessarily
 * paired with the one server id this directory has ever had, so it is filed
 * under the current one. Nothing is rewritten on read: an upgrade only reaches
 * disk on the next write, so a v1 file that is never written stays readable by
 * an older build.
 */
function readStore(): PeerStore {
  const raw = readJson<Record<string, unknown>>(peersFile(), {});
  if (raw && (raw as { version?: number }).version === 2) {
    const store = raw as unknown as PeerStore;
    return { version: 2, peers: store.peers ?? {} };
  }

  const migrated: PeerStore = { version: 2, peers: {} };
  const legacyServerId = readJson<{ serverId?: string }>(keyFile(), {}).serverId;
  for (const [extId, value] of Object.entries(raw)) {
    const rec = value as PeerRecord;
    if (!rec || typeof rec.pairingSecret !== 'string') continue;
    migrated.peers[extId] = { [legacyServerId ?? 'legacy']: rec };
  }
  return migrated;
}

function writeStore(store: PeerStore): void {
  writeJsonPrivate(peersFile(), store);
}

/**
 * Serialises read-modify-write on the peer store across processes.
 *
 * Every agent session spawns its own server, all of them sharing one
 * `~/.onbridge`, and a plain read-then-write loses whichever write landed
 * first. The lock is a directory, because `mkdir` is atomic on every filesystem
 * that matters and needs no dependency.
 *
 * Synchronous on purpose. The critical section is one small file write, the
 * callers are on the handshake path where ordering is what we are buying, and
 * making them async would spread `await` through code whose whole point is that
 * nothing interleaves. The wait is bounded and a stale lock is broken, so the
 * worst case is a few hundred milliseconds once, not a hang.
 */
const STORE_LOCK_WAIT_MS = 2_000;
const STORE_LOCK_STALE_MS = 10_000;

function sleepSync(ms: number): void {
  // `Atomics.wait` is the only way to block without spinning the CPU. A shared
  // buffer nobody else touches never has a value to wake on, so this always
  // runs the full timeout.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockPath(name: string): string {
  return join(dir(), `.${name.replace(/[^a-z0-9_-]/gi, '_')}.lock`);
}

function tryLock(path: string): boolean {
  ensureDir();
  try {
    mkdirSync(path);
    writeFileSync(join(path, 'owner'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

/** True if the holder is gone or has held it implausibly long. */
function lockIsStale(path: string, staleMs: number): boolean {
  try {
    const owner = readJson<{ pid?: number; at?: number }>(join(path, 'owner'), {});
    if (owner.at && Date.now() - owner.at > staleMs) return true;
    if (typeof owner.pid === 'number' && owner.pid !== process.pid) {
      try {
        // Signal 0 tests for existence without delivering anything.
        process.kill(owner.pid, 0);
      } catch {
        return true; // holder exited without releasing
      }
    }
    const age = Date.now() - statSync(path).mtimeMs;
    return age > staleMs;
  } catch {
    return true;
  }
}

function unlock(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

function withLock<T>(name: string, fn: () => T): T {
  const path = lockPath(name);
  const deadline = Date.now() + STORE_LOCK_WAIT_MS;
  let held = tryLock(path);
  while (!held && Date.now() < deadline) {
    if (lockIsStale(path, STORE_LOCK_STALE_MS)) unlock(path);
    sleepSync(25);
    held = tryLock(path);
  }
  // Losing the lock must not lose the write: a dropped `savePeer` is a pairing
  // that exists on the extension side and nowhere else, which is the exact
  // inconsistency this whole mechanism exists to prevent.
  if (!held) unlock(path);
  try {
    return fn();
  } finally {
    unlock(path);
  }
}

const withStoreLock = <T,>(fn: () => T): T => withLock('peers', fn);

export function getPeer(extId: string, serverId: string): PeerRecord | undefined {
  return readStore().peers[extId]?.[serverId];
}

export function savePeer(extId: string, serverId: string, pairingSecret: string): void {
  withStoreLock(() => {
    const store = readStore();
    const now = Date.now();
    store.peers[extId] = { ...(store.peers[extId] ?? {}), [serverId]: { pairingSecret, pairedAt: now, lastSeen: now } };
    writeStore(store);
  });
}

/**
 * Records that this pairing was just used.
 *
 * `lastSeen` is the only thing that distinguishes a live pairing from one left
 * behind by a session that ended months ago, so it has to move on more than the
 * moment of pairing — where it sat before, permanently equal to `pairedAt`.
 * Throttled because it is also called from the heartbeat, and a file write
 * every fifteen seconds for the life of a session is not a trade worth making
 * for minute-resolution freshness.
 */
const TOUCH_INTERVAL_MS = 60_000;
const lastTouch = new Map<string, number>();

export function touchPeer(extId: string, serverId: string, force = false): void {
  const key = `${extId}|${serverId}`;
  const previous = lastTouch.get(key) ?? 0;
  if (!force && Date.now() - previous < TOUCH_INTERVAL_MS) return;
  lastTouch.set(key, Date.now());

  withStoreLock(() => {
    const store = readStore();
    const rec = store.peers[extId]?.[serverId];
    if (!rec) return;
    rec.lastSeen = Date.now();
    writeStore(store);
  });
}

export function forgetPeer(extId: string, serverId: string): void {
  withStoreLock(() => {
    const store = readStore();
    const byServer = store.peers[extId];
    if (!byServer) return;
    delete byServer[serverId];
    if (Object.keys(byServer).length === 0) delete store.peers[extId];
    writeStore(store);
  });
}

/**
 * What the server can actually say about a pairing whose proof just failed.
 *
 * A stale local secret and a hostile takeover look identical from the browser
 * — both are `invalid auth proof` — and the panel used to assert the hostile
 * reading as fact. The timestamps separate them: a record that was never
 * rewritten since it was created was not replaced by anything. Handing the
 * facts to the panel is what lets it stop guessing.
 */
export function pairingEvidence(extId: string, serverId: string): PairingEvidence {
  const rec = getPeer(extId, serverId);
  let storeWrittenAt: number | undefined;
  try {
    storeWrittenAt = Math.round(statSync(peersFile()).mtimeMs);
  } catch {
    /* no store yet */
  }
  return { pairedAt: rec?.pairedAt, lastSeen: rec?.lastSeen, storeWrittenAt };
}

/**
 * Claims the right to run a pairing prompt for `extId`, or waits for the
 * sibling process that is already running one.
 *
 * This is the fix for the defect that produced both the prompt storm and the
 * unrecoverable `invalid auth proof`. A user-scope MCP install spawns one
 * server per editor session — six were live on the machine that reported it —
 * and all of them share one `~/.onbridge`. Started together against an empty
 * store, each saw no record, each asked the user to pair, each derived a
 * *different* secret, and the last writer on each side won independently. The
 * extension ended up holding one secret and the store another, which is a dead
 * end that no amount of reconnecting fixes.
 *
 * With this, exactly one of them prompts. The others wait, find the record the
 * winner wrote, and authenticate with it — so N concurrent agents cost one
 * approval and all of them end up working.
 */
export interface PairingClaim {
  /** Run the pairing prompt; call `release` once it has resolved either way. */
  pair: boolean;
  record?: PeerRecord;
  release: () => void;
  /** A sibling was pairing and we waited for it. Worth logging. */
  waited: boolean;
}

const PAIRING_LOCK_STALE_MS = 120_000; // must outlast the 90s handshake budget

export async function claimPairing(
  extId: string,
  serverId: string,
  budgetMs: number,
): Promise<PairingClaim> {
  const path = lockPath(`pairing-${extId}`);
  const noop = () => {};
  const deadline = Date.now() + budgetMs;
  let waited = false;

  for (let breaks = 0; ; ) {
    const existing = getPeer(extId, serverId);
    if (existing) return { pair: false, record: existing, release: noop, waited };

    if (tryLock(path)) {
      // Re-read under the lock: the sibling may have finished in the gap
      // between our check above and our acquire.
      const again = getPeer(extId, serverId);
      if (again) {
        unlock(path);
        return { pair: false, record: again, release: noop, waited };
      }
      return { pair: true, release: () => unlock(path), waited };
    }

    if (lockIsStale(path, PAIRING_LOCK_STALE_MS) && breaks < 3) {
      breaks++;
      unlock(path);
      continue;
    }

    if (Date.now() >= deadline) {
      // The sibling is still holding a prompt open. Pairing anyway would
      // recreate the clobber, so refuse this handshake instead and let the
      // extension redial once the other one has settled.
      return { pair: false, release: noop, waited: true };
    }

    waited = true;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * How many onbridge servers are listening on the loopback range right now.
 *
 * One user-scope MCP install silently turns "one agent" into "one agent per
 * terminal tab", and ten of those exhaust the range. The count is the only
 * cheap signal that this is what is happening, so it is logged at startup and
 * shown to the user rather than left to be inferred from a port number.
 */
export async function countListeningServers(): Promise<number> {
  const probes = WS_PORT_RANGE.map(
    (port) =>
      new Promise<boolean>((resolve) => {
        const socket = connect({ port, host: '127.0.0.1' });
        const done = (open: boolean) => {
          socket.destroy();
          resolve(open);
        };
        socket.setTimeout(250);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
      }),
  );
  return (await Promise.all(probes)).filter(Boolean).length;
}

/**
 * Best-effort guess at which agent is running us, from the environment alone.
 *
 * Only used until MCP `initialize` arrives with the client's own `clientInfo`,
 * which is authoritative and usually lands within a second of startup. The guess
 * matters because the extension can finish its handshake first, and "An AI agent
 * wants to control your browser" is not a prompt anyone can make a decision
 * about.
 *
 * Order matters: the explicit override wins, then agent-specific markers, then
 * the terminal. None of this is a security boundary — a local process can set
 * any of these. It is a label for the human.
 */
function detectAgentFromEnv(): { name: string; source: 'env' | 'unknown' } {
  const env = process.env;
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return { name: 'Claude Code', source: 'env' };
  if (env.CURSOR_TRACE_ID || env.CURSOR_SESSION_ID) return { name: 'Cursor', source: 'env' };
  if (env.WINDSURF_SESSION_ID) return { name: 'Windsurf', source: 'env' };
  if (env.TERM_PROGRAM === 'vscode' && env.VSCODE_GIT_ASKPASS_MAIN) {
    return { name: 'VS Code', source: 'env' };
  }
  if (env.ZED_TERM) return { name: 'Zed', source: 'env' };

  return { name: 'Unidentified agent', source: 'unknown' };
}

/**
 * Identity of the agent driving this server, shown in the extension.
 *
 * `clientInfo` is filled in from MCP `initialize` once the agent client
 * introduces itself; until then we fall back to the environment sniff.
 */
export function buildAgentIdentity(opts: {
  port: number;
  serverVersion: string;
  startedAt: number;
  clientInfo?: { name?: string; version?: string; title?: string };
}): AgentIdentity {
  // An explicit override outranks everything, including what the client says
  // about itself: someone who set it has a reason, and silently ignoring it
  // would make the label untrustworthy in exactly the setups that use it.
  const override = process.env.ONBRIDGE_AGENT_NAME?.trim();
  const reported = opts.clientInfo?.title?.trim() || opts.clientInfo?.name?.trim();
  const guessed = detectAgentFromEnv();

  const name = override ?? (reported ? prettifyClientName(reported) : guessed.name);
  const source: AgentIdentity['source'] = override ? 'env' : reported ? 'mcp' : guessed.source;

  return {
    name,
    version: opts.clientInfo?.version,
    source,
    pid: process.pid,
    cwd: safeCwd(),
    port: opts.port,
    serverVersion: opts.serverVersion,
    startedAt: opts.startedAt,
  };
}

/** MCP clients report slugs like `claude-code`; the panel shows this to a human. */
function prettifyClientName(raw: string): string {
  if (/[A-Z ]/.test(raw)) return raw; // already human-formatted
  return raw
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function safeCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    // cwd can be gone if the directory was deleted out from under us.
    return undefined;
  }
}

/** The set of extension ids we have ever paired with. */
export function knownExtensionIds(): string[] {
  return Object.entries(readStore().peers)
    .filter(([, byServer]) => Object.keys(byServer ?? {}).length > 0)
    .map(([extId]) => extId);
}

/** Ids configured explicitly. When present they, not trust-on-first-use, decide. */
function explicitIds(): string[] {
  return [
    process.env.ONBRIDGE_EXTENSION_ID?.trim(),
    ...(process.env.ONBRIDGE_DEV_EXTENSION_IDS ?? '').split(',').map((s) => s.trim()),
  ]
    .filter((v): v is string => Boolean(v))
    .map((id) => id.replace(/^chrome-extension:\/\//, ''));
}

/** `chrome-extension://abcd…` -> `abcd…`. Anything else yields undefined. */
export function extensionIdFromOrigin(origin?: string): string | undefined {
  const m = /^chrome-extension:\/\/([a-z0-9]+)\/?$/i.exec(origin ?? '');
  return m?.[1];
}

/**
 * Decides whether a peer may speak for `extId`, given the Origin it connected
 * from. Returns a refusal message, or null to allow.
 *
 * Two checks, because `extId` arrives inside the `hello` frame and is therefore
 * whatever the peer says it is:
 *
 *  1. It must match the Origin header. Chrome sets that header itself for a real
 *     extension, so this binds the claimed identity to the connection. Without
 *     it any peer could claim the real extension's id — enough to have its
 *     pairing record reset and taken over.
 *  2. Trust on first use. Once we have paired with someone, a *different* id is
 *     refused. The server cannot verify that a human approved a pairing (the
 *     proof a peer sends is derived from the key exchange it just performed, so
 *     it can always produce one); pinning the first id we saw is what stops a
 *     second local process from silently enrolling itself later.
 *
 * TOFU applies only when no ids are configured explicitly. If the deployment
 * names its extension, that list is the authority and pinning would only get in
 * the way of a deliberate change.
 */
/**
 * Recovery guidance for a refused peer. Too long for a close reason; logged.
 *
 * It says *all of it* deliberately. The obvious careful thing to do with a file
 * that holds several entries is to remove only your own — and that is the one
 * action that makes this worse: any surviving entry keeps trust-on-first-use
 * armed, so the very extension you are trying to pair is then refused with a
 * message about a different problem entirely. Removing one key is only correct
 * when it is the last key.
 */
export function peerRefusalHelp(extId: string): string {
  return (
    `To pair "${extId}" instead, delete the whole of ${peersFile()} — not just one ` +
    'entry, since any entry left behind keeps refusing new extensions — and pair ' +
    'again, or list it in ONBRIDGE_DEV_EXTENSION_IDS.'
  );
}

export function checkPeerIdentity(extId: string, origin?: string): string | null {
  if (!extId) return 'hello did not name an extension';

  const originId = extensionIdFromOrigin(origin);
  if (!originId) {
    // The upgrade check already demands a chrome-extension:// origin, so this is
    // unreachable today. It stays because the two checks are separated by a lot
    // of code, and a peer with no origin must never fall through to being
    // trusted on the id it named for itself.
    return 'connection has no usable chrome-extension:// origin';
  }
  if (extId !== originId) {
    return `extension id "${extId}" does not match the connection origin (${originId})`;
  }

  if (explicitIds().length > 0) return null;

  const known = knownExtensionIds();
  if (known.length > 0 && !known.includes(extId)) {
    // Kept short: this travels as a WebSocket close reason, which is capped at
    // 123 bytes. The recovery instructions go to the log instead.
    return `already paired with a different extension; refusing "${extId}"`;
  }

  return null;
}

/**
 * Origin policy for the WebSocket upgrade.
 *
 * Chrome sets the Origin header itself and a web page cannot forge it, so this
 * check alone excludes every remote attacker — the single most important rule in
 * the transport. A page on any site can open a socket to 127.0.0.1 (WebSockets
 * are not subject to CORS), and this is what stops it.
 *
 * When specific ids are configured we match them exactly. When none are — local
 * development before the Web Store id exists — we fall back to allowing any
 * `chrome-extension://` origin and warn. That fallback still blocks every web
 * page; it only widens trust to other installed extensions, which the user
 * installed deliberately and which carry their own permissions.
 */
export function makeOriginCheck(log: (msg: string) => void): (origin?: string) => boolean {
  const ids = [
    // Published Chrome Web Store id. Pinned via the manifest `key` field so dev
    // and released builds share one origin.
    process.env.ONBRIDGE_EXTENSION_ID?.trim(),
    ...(process.env.ONBRIDGE_DEV_EXTENSION_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ].filter((v): v is string => Boolean(v));

  if (ids.length === 0) {
    log(
      'WARNING: no ONBRIDGE_EXTENSION_ID set — accepting any chrome-extension:// origin. ' +
        'Web pages are still rejected. Set ONBRIDGE_EXTENSION_ID before release.',
    );
    return (origin?: string) => Boolean(origin?.startsWith('chrome-extension://'));
  }

  const allowed = new Set(
    ids.map((id) => (id.startsWith('chrome-extension://') ? id : `chrome-extension://${id}`)),
  );
  return (origin?: string) => Boolean(origin && allowed.has(origin));
}
