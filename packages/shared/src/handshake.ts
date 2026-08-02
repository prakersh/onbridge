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
 *    │  pair_required {agentName}                            │
 *    │ <─────────────────────────────────────────────────────│
 *    │  (side panel: Allow / Deny)                           │
 *    │  pair_confirm {proof}          or  pair_denied        │
 *    │ ─────────────────────────────────────────────────────>│
 *    │                                                       │
 *   thereafter:                                              │
 *    │  challenge    {nonce}                                 │
 *    │ <─────────────────────────────────────────────────────│
 *    │  auth         {proof, nonce}                          │
 *    │ ─────────────────────────────────────────────────────>│
 *    │  auth_ok      {proof}   ← extension verifies this too │
 *    │ <─────────────────────────────────────────────────────│
 *    │                                                       │
 *    │  ── all further frames sealed under sessionKey ──     │
 *
 * The pairing secret is *derived* on both sides from the same ECDH output. It is
 * never transmitted, and it never enters the agent's context.
 */

import {
  fingerprint,
  fromB64,
  proof as hmacProof,
  safeEqual,
  toB64,
  type SealedFrame,
} from './crypto.js';

export const HANDSHAKE_VERSION = 1;

/** Domain-separation labels. Distinct per direction to prevent proof reflection. */
export const PROOF_PAIR = 'onbridge/pair/ext';
export const PROOF_AUTH_EXT = 'onbridge/auth/ext';
export const PROOF_AUTH_SRV = 'onbridge/auth/srv';

export type HandshakeFrame =
  | { t: 'hello'; v: number; extId: string; ePub: string; eNonce: string }
  | { t: 'hello_ack'; sPub: string; sNonce: string; serverId: string; paired: boolean }
  | { t: 'pair_required'; agentName: string }
  | { t: 'pair_confirm'; proof: string }
  | { t: 'pair_denied' }
  /**
   * Extension holds no secret for a server that believes they are paired —
   * typically after an extension reinstall. Asks the server to drop its record
   * so a fresh pairing can run. Unauthenticated, but harmless: re-pairing still
   * requires the user to click Allow, so the worst case is a nuisance prompt.
   */
  | { t: 'pair_reset' }
  | { t: 'challenge'; nonce: string }
  | { t: 'auth'; proof: string }
  | { t: 'auth_ok'; proof: string }
  | { t: 'auth_fail'; reason: string }
  | ({ t: 'enc' } & SealedFrame);

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
