/**
 * Handshake protocol for the onbridge secure channel.
 *
 *   EXT                                                     SRV
 *    │  hello        {v, extId, ePub, eNonce}                │
 *    │ ─────────────────────────────────────────────────────>│
 *    │                                                       │  Origin already
 *    │                                                       │  checked at upgrade
 *    │  hello_ack    {sPub, sNonce, serverId, paired}        │
 *    │ <─────────────────────────────────────────────────────│
 *    │                                                       │
 *    │  both: shared = ECDH(...)                             │
 *    │        handshakeKey, pairingSecret = HKDF(shared, ...)│
 *    │        sessionId = H(transcript)                      │
 *    │                                                       │
 *    │  ── frames below are sealed under handshakeKey ──     │
 *    │                                                       │
 *   first run:                                               │
 *    │  pair_required {agent}                                │
 *    │ <─────────────────────────────────────────────────────│
 *    │  (side panel: Allow / Deny)                           │
 *    │  pair_confirm {proof}          or  pair_denied        │
 *    │ ─────────────────────────────────────────────────────>│
 *    │                                                       │
 *   thereafter:                                              │
 *    │  challenge    {nonce, agent}                          │
 *    │ <─────────────────────────────────────────────────────│
 *    │  auth         {proof, nonce}                          │
 *    │ ─────────────────────────────────────────────────────>│
 *    │  auth_ok      {proof}   ← extension verifies this too │
 *    │ <─────────────────────────────────────────────────────│
 *    │        …or auth_fail {reason, evidence}               │
 *    │                                                       │
 *    │  ── all further frames sealed under sessionKey ──     │
 *
 * The pairing secret is *derived* on both sides from the same ECDH output. It is
 * never transmitted, and it never enters the agent's context.
 *
 * Which branch runs is decided by the frame the server sends *after* `hello_ack`
 * — `pair_required` or `challenge` — not by `hello_ack.paired`. Those can
 * disagree: several agent processes share one `~/.onbridge`, so a server that
 * saw no pairing record when it answered `hello` may find one moments later,
 * written by a sibling that was mid-pairing. `hello_ack.paired` is therefore a
 * hint for the UI, and the branching frame is the authority. Choosing the secret
 * at `hello_ack` is what made concurrent first-runs clobber one another and
 * dead-end at `invalid auth proof`.
 */

import {
  fingerprint,
  fromB64,
  proof as hmacProof,
  safeEqual,
  toB64,
  type SealedFrame,
} from './crypto.js';

/**
 * Bumped to 3: the server may now answer `hello_ack {paired:false}` with a
 * `challenge` rather than `pair_required`, when a sibling server process
 * finishes pairing while this handshake is waiting on the cross-process pairing
 * lock. An older extension chooses its secret at `hello_ack` and would answer
 * that challenge with the wrong one — failing as `invalid auth proof`, which is
 * exactly the dead end this release removes. A version check turns that into
 * "update the browser extension", which is actionable.
 *
 * (2 added the agent-identity fields.) A mismatched peer is rejected with a
 * message telling the user which side to update, which is far better than the
 * silent misbehaviour you get from changing frame shapes in place.
 */
export const HANDSHAKE_VERSION = 3;

/** Domain-separation labels. Distinct per direction to prevent proof reflection. */
export const PROOF_PAIR = 'onbridge/pair/ext';
export const PROOF_AUTH_EXT = 'onbridge/auth/ext';
export const PROOF_AUTH_SRV = 'onbridge/auth/srv';

/**
 * Who is on the other end of the bridge.
 *
 * This exists so the user is never approving "An AI agent" in the abstract. With
 * several agents able to connect at once, "which one is this?" stops being a
 * nicety and becomes the difference between approving the session you just
 * started and approving one you forgot was running.
 *
 * None of it is a security claim — a hostile local process can put anything it
 * likes here. Authentication is the pairing secret; this is for the human.
 */
export interface AgentIdentity {
  /** e.g. "Claude Code". From MCP clientInfo when available. */
  name: string;
  version?: string;
  /**
   * How `name` was established, so the panel can distinguish a name the client
   * reported from one we inferred from the environment.
   */
  source: 'mcp' | 'env' | 'unknown';
  /** Process id and working directory — usually the project being worked on. */
  pid: number;
  cwd?: string;
  /** Which loopback port this agent's bridge bound. Disambiguates same-name agents. */
  port: number;
  serverVersion: string;
  startedAt: number;
  /**
   * A short code this agent session also shows in its own tool results, so the user can match the request in the panel with the session on their screen, even two sessions in the same project. Random per server process; identifies, does not authenticate. Absent from servers older than it.
   */
  code?: string;
}

export type HandshakeFrame =
  | {
      t: 'hello';
      v: number;
      extId: string;
      ePub: string;
      eNonce: string;
      /**
       * A random id for this browser profile's copy of the extension, created once. Every copy of the store extension shares one `extId`, so without it a second profile pairing with the same agent overwrote the first profile's pairing, and each browser could only be connected to an agent on its own. Identifies, does not authenticate: the pairing secret still does that. Absent from older extensions, which the server treats as one shared install.
       */
      installId?: string;
    }
  | { t: 'hello_ack'; sPub: string; sNonce: string; serverId: string; paired: boolean }
  | { t: 'pair_required'; agent: AgentIdentity }
  | { t: 'pair_confirm'; proof: string }
  | { t: 'pair_denied' }
  /**
   * Extension holds no secret for a server that believes they are paired —
   * typically after an extension reinstall. Asks the server to drop its record
   * so a fresh pairing can run. Unauthenticated, but harmless: re-pairing still
   * requires the user to click Allow, so the worst case is a nuisance prompt.
   */
  | { t: 'pair_reset' }
  | { t: 'challenge'; nonce: string; agent: AgentIdentity }
  | { t: 'auth'; proof: string }
  | { t: 'auth_ok'; proof: string }
  | { t: 'auth_fail'; reason: string; evidence?: PairingEvidence }
  | ({ t: 'enc' } & SealedFrame);

/**
 * What the server actually knows about the record a failed proof was checked
 * against.
 *
 * A stale local secret and a hostile takeover produce the identical symptom —
 * `invalid auth proof` — but leave very different traces, and the server is
 * holding the trace that separates them. Asserting "its record was replaced" as
 * fact, as the panel used to, sent people hunting for an intruder when the peer
 * record had not been touched in a month. Reporting the timestamps lets the
 * panel say what is known and let the human draw the conclusion.
 *
 * Not a security claim: a peer that can reach this far can say anything. It is
 * diagnostic text for a person, exactly like `AgentIdentity`.
 */
export interface PairingEvidence {
  /** When the record being checked against was first created. */
  pairedAt?: number;
  /** Last successful authentication against it. */
  lastSeen?: number;
  /** mtime of the peer store. Equal to `pairedAt` means nothing rewrote it. */
  storeWrittenAt?: number;
  /** How many onbridge servers are listening on the loopback range right now. */
  siblingServers?: number;
}

/**
 * Binds every value both sides agreed on. Computed independently — never sent —
 * so a tampered handshake yields divergent session ids and the channel fails.
 */
export async function computeSessionId(
  ePub: string,
  sPub: string,
  eNonce: string,
  sNonce: string,
): Promise<string> {
  const parts = [ePub, sPub, eNonce, sNonce].join('|');
  return fingerprint(new TextEncoder().encode(parts));
}

export async function makeProof(
  pairingSecret: Uint8Array,
  label: string,
  sessionId: string,
  nonce = '',
): Promise<string> {
  return hmacProof(pairingSecret, label, nonce ? `${sessionId}|${nonce}` : sessionId);
}

export async function verifyProof(
  pairingSecret: Uint8Array,
  label: string,
  sessionId: string,
  nonce: string,
  received: string,
): Promise<boolean> {
  const expected = await makeProof(pairingSecret, label, sessionId, nonce);
  return safeEqual(expected, received);
}

/**
 * Rejects replayed or reordered frames. GCM already guarantees a frame was not
 * altered; this guarantees it was not *repeated*.
 */
export class ReplayGuard {
  private highest = -1;

  accept(counter: number): boolean {
    if (!Number.isInteger(counter) || counter <= this.highest) return false;
    this.highest = counter;
    return true;
  }
}

export { toB64, fromB64 };
