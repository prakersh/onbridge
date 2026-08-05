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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AgentIdentity } from '@onbridge/shared';

/** ONBRIDGE_HOME lets tests point at a scratch dir instead of the real one. */
const DIR = process.env.ONBRIDGE_HOME || join(homedir(), '.onbridge');
const KEY_FILE = join(DIR, 'server-key.json');
const PEERS_FILE = join(DIR, 'peers.json');

export interface PeerRecord {
  /** base64, 32 bytes. Derived during pairing, never transmitted. */
  pairingSecret: string;
  pairedAt: number;
  lastSeen: number;
}

function ensureDir(): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
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
  // mode on writeFileSync only applies at creation, so chmod-on-write is implicit
  // in the 0o600 flag here for new files; existing files keep their mode.
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

export function getServerId(): string {
  ensureDir();
  const existing = readJson<{ serverId?: string }>(KEY_FILE, {});
  if (existing.serverId) return existing.serverId;

  const serverId = randomBytes(16).toString('base64');
  writeJsonPrivate(KEY_FILE, { serverId, createdAt: Date.now() });
  return serverId;
}

export function getPeer(extId: string): PeerRecord | undefined {
  return readJson<Record<string, PeerRecord>>(PEERS_FILE, {})[extId];
}

export function savePeer(extId: string, pairingSecret: string): void {
  const peers = readJson<Record<string, PeerRecord>>(PEERS_FILE, {});
  peers[extId] = { pairingSecret, pairedAt: Date.now(), lastSeen: Date.now() };
  writeJsonPrivate(PEERS_FILE, peers);
}

export function touchPeer(extId: string): void {
  const peers = readJson<Record<string, PeerRecord>>(PEERS_FILE, {});
  if (!peers[extId]) return;
  peers[extId].lastSeen = Date.now();
  writeJsonPrivate(PEERS_FILE, peers);
}

export function forgetPeer(extId: string): void {
  const peers = readJson<Record<string, PeerRecord>>(PEERS_FILE, {});
  delete peers[extId];
  writeJsonPrivate(PEERS_FILE, peers);
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
