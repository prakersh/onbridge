import { describe, it, expect } from 'vitest';
import {
  deriveHandshakeKeys,
  deriveSessionKey,
  deriveSharedSecret,
  generateEphemeralKeyPair,
  open,
  randomBytes,
  safeEqual,
  seal,
  toB64,
} from '../src/crypto.js';
import { ReplayGuard, makeProof, verifyProof } from '../src/handshake.js';

/** Both halves of one handshake, as the server and extension would derive them. */
async function pair() {
  const a = await generateEphemeralKeyPair();
  const b = await generateEphemeralKeyPair();
  const eNonce = randomBytes(16);
  const sNonce = randomBytes(16);
  const sharedA = await deriveSharedSecret(a.privateKey, b.publicKeyB64);
  const sharedB = await deriveSharedSecret(b.privateKey, a.publicKeyB64);
  return { a, b, eNonce, sNonce, sharedA, sharedB };
}

describe('ECDH agreement', () => {
  it('both sides derive the same secret', async () => {
    const { sharedA, sharedB } = await pair();
    expect(toB64(sharedA)).toBe(toB64(sharedB));
  });

  it('derives the pairing secret identically without transmitting it', async () => {
    const { sharedA, sharedB, eNonce, sNonce } = await pair();
    const ka = await deriveHandshakeKeys(sharedA, eNonce, sNonce);
    const kb = await deriveHandshakeKeys(sharedB, eNonce, sNonce);
    expect(toB64(ka.pairingSecret)).toBe(toB64(kb.pairingSecret));
  });

  it('a third party deriving with its own key gets a different secret', async () => {
    const { a, eNonce, sNonce } = await pair();
    const impostor = await generateEphemeralKeyPair();
    const sharedReal = await deriveSharedSecret(a.privateKey, (await generateEphemeralKeyPair()).publicKeyB64);
    const sharedFake = await deriveSharedSecret(impostor.privateKey, a.publicKeyB64);
    const kr = await deriveHandshakeKeys(sharedReal, eNonce, sNonce);
    const kf = await deriveHandshakeKeys(sharedFake, eNonce, sNonce);
    expect(toB64(kr.pairingSecret)).not.toBe(toB64(kf.pairingSecret));
  });
});

describe('AEAD framing', () => {
  it('round-trips a message', async () => {
    const { sharedA, eNonce, sNonce } = await pair();
    const { handshakeKey } = await deriveHandshakeKeys(sharedA, eNonce, sNonce);
    const frame = await seal(handshakeKey, 0, 'hello world');
    expect(await open(handshakeKey, frame)).toBe('hello world');
  });

  it('rejects tampered ciphertext', async () => {
    const { sharedA, eNonce, sNonce } = await pair();
    const { handshakeKey } = await deriveHandshakeKeys(sharedA, eNonce, sNonce);
    const frame = await seal(handshakeKey, 0, 'transfer $10');
    const bytes = Buffer.from(frame.ct, 'base64');
    bytes[0] ^= 0xff;
    await expect(open(handshakeKey, { ...frame, ct: bytes.toString('base64') })).rejects.toThrow();
  });

  it('rejects a frame renumbered to a different counter', async () => {
    // The counter is authenticated as AAD, so a captured frame cannot be moved
    // to another position in the stream.
    const { sharedA, eNonce, sNonce } = await pair();
    const { handshakeKey } = await deriveHandshakeKeys(sharedA, eNonce, sNonce);
    const frame = await seal(handshakeKey, 7, 'click');
    await expect(open(handshakeKey, { ...frame, c: 8 })).rejects.toThrow();
  });

  it('cannot be opened with a key derived without the pairing secret', async () => {
    const { sharedA, eNonce, sNonce } = await pair();
    const real = await deriveSessionKey(sharedA, randomBytes(32), eNonce, sNonce);
    const wrong = await deriveSessionKey(sharedA, randomBytes(32), eNonce, sNonce);
    const frame = await seal(real, 0, 'secret');
    await expect(open(wrong, frame)).rejects.toThrow();
  });
});

describe('ReplayGuard', () => {
  it('accepts strictly increasing counters', () => {
    const g = new ReplayGuard();
    expect(g.accept(0)).toBe(true);
    expect(g.accept(1)).toBe(true);
    expect(g.accept(2)).toBe(true);
  });

  it('rejects a replayed counter', () => {
    const g = new ReplayGuard();
    g.accept(5);
    expect(g.accept(5)).toBe(false);
  });

  it('rejects an out-of-order counter', () => {
    const g = new ReplayGuard();
    g.accept(5);
    expect(g.accept(4)).toBe(false);
  });

  it('rejects non-integers', () => {
    const g = new ReplayGuard();
    expect(g.accept(1.5)).toBe(false);
    expect(g.accept(NaN)).toBe(false);
  });
});

describe('proofs', () => {
  it('verifies a well-formed proof', async () => {
    const secret = randomBytes(32);
    const p = await makeProof(secret, 'label', 'session', 'nonce');
    expect(await verifyProof(secret, 'label', 'session', 'nonce', p)).toBe(true);
  });

  it('rejects a proof made with a different secret', async () => {
    const p = await makeProof(randomBytes(32), 'label', 'session', 'nonce');
    expect(await verifyProof(randomBytes(32), 'label', 'session', 'nonce', p)).toBe(false);
  });

  it('rejects a proof reflected across labels', async () => {
    // Domain separation: an extension proof must never satisfy a server check.
    const secret = randomBytes(32);
    const p = await makeProof(secret, 'onbridge/auth/ext', 'session', 'nonce');
    expect(await verifyProof(secret, 'onbridge/auth/srv', 'session', 'nonce', p)).toBe(false);
  });

  it('rejects a proof bound to a different nonce', async () => {
    const secret = randomBytes(32);
    const p = await makeProof(secret, 'label', 'session', 'nonce-a');
    expect(await verifyProof(secret, 'label', 'session', 'nonce-b', p)).toBe(false);
  });
});

describe('safeEqual', () => {
  it('matches identical strings', () => expect(safeEqual('abc', 'abc')).toBe(true));
  it('rejects differing strings', () => expect(safeEqual('abc', 'abd')).toBe(false));
  it('rejects differing lengths', () => expect(safeEqual('abc', 'abcd')).toBe(false));
});
