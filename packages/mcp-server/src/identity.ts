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

/** Shown in the extension's pairing prompt so the user knows who is asking. */
export function getAgentName(): string {
  return process.env.ONBRIDGE_AGENT_NAME?.trim() || 'An AI agent';
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
