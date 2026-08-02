/**
 * Isomorphic crypto primitives for the onbridge secure channel.
 *
 * Runs unmodified in Node (>=20, `globalThis.crypto`) and in the extension
 * service worker. Uses only WebCrypto — no dependencies on either side.
 *
 * Suite: ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM.
 *
 * P-256 is chosen over X25519 deliberately: it is available in every runtime we
 * target today, so there is no fallback negotiation to get wrong.
 */

const subtle = globalThis.crypto.subtle;

const KDF_HANDSHAKE = 'onbridge-hs-v1';
const KDF_SESSION = 'onbridge-session-v1';
const KDF_PAIRING = 'onbridge-pair-v1';

// ── encoding ────────────────────────────────────────────────────────────────

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ── ECDH ────────────────────────────────────────────────────────────────────

export interface EphemeralKeyPair {
  privateKey: CryptoKey;
  publicKeyB64: string;
}

/** Fresh ECDH keypair. One per connection — this is what gives forward secrecy. */
export async function generateEphemeralKeyPair(): Promise<EphemeralKeyPair> {
  const kp = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { privateKey: kp.privateKey, publicKeyB64: toB64(raw) };
}

async function importPeerPublicKey(b64: string): Promise<CryptoKey> {
  return subtle.importKey(
    'raw',
    fromB64(b64) as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
}

/** Raw ECDH shared secret. Never used directly as a key — always run through HKDF. */
export async function deriveSharedSecret(
  privateKey: CryptoKey,
  peerPublicKeyB64: string,
): Promise<Uint8Array> {
  const peer = await importPeerPublicKey(peerPublicKeyB64);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  return new Uint8Array(bits);
}

// ── HKDF ────────────────────────────────────────────────────────────────────

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  bytes = 32,
): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  const out = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: enc.encode(info) },
    key,
    bytes * 8,
  );
  return new Uint8Array(out);
}

/**
 * Keys derived from one handshake.
 *
 * `handshakeKey` protects the pairing/auth exchange, when no pairing secret
 * exists yet. `sessionKey` protects all command traffic and is bound to the
 * pairing secret as well as the ECDH output — so a peer that does not hold the
 * pairing secret derives a different key and every frame it sends fails to
 * decrypt. That binding is the real mutual authentication; the explicit proofs
 * below exist so failures produce a clear message instead of garbage.
 */
export interface DerivedKeys {
  handshakeKey: CryptoKey;
  pairingSecret: Uint8Array;
}

export async function deriveHandshakeKeys(
  shared: Uint8Array,
  eNonce: Uint8Array,
  sNonce: Uint8Array,
): Promise<DerivedKeys> {
  const salt = concat(eNonce, sNonce);
  const hsBytes = await hkdf(shared, salt, KDF_HANDSHAKE);
  const pairingSecret = await hkdf(shared, salt, KDF_PAIRING);
  return { handshakeKey: await importAesKey(hsBytes), pairingSecret };
}

/** Session key, bound to both the ECDH output and the pairing secret. */
export async function deriveSessionKey(
  shared: Uint8Array,
  pairingSecret: Uint8Array,
  eNonce: Uint8Array,
  sNonce: Uint8Array,
): Promise<CryptoKey> {
  const bytes = await hkdf(concat(shared, pairingSecret), concat(eNonce, sNonce), KDF_SESSION);
  return importAesKey(bytes);
}

async function importAesKey(bytes: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('raw', bytes as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

// ── AEAD ────────────────────────────────────────────────────────────────────

export interface SealedFrame {
  /** Monotonic per-direction counter. Doubles as replay protection. */
  c: number;
  iv: string;
  ct: string;
}

/**
 * The counter is authenticated as additional data, so an attacker cannot renumber
 * a captured frame to slot it elsewhere in the stream.
 */
export async function seal(key: CryptoKey, counter: number, plaintext: string): Promise<SealedFrame> {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(String(counter)) },
    key,
    enc.encode(plaintext) as BufferSource,
  );
  return { c: counter, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

export async function open(key: CryptoKey, frame: SealedFrame): Promise<string> {
  const pt = await subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromB64(frame.iv) as BufferSource,
      additionalData: enc.encode(String(frame.c)),
    },
    key,
    fromB64(frame.ct) as BufferSource,
  );
  return dec.decode(pt);
}

// ── HMAC proofs ─────────────────────────────────────────────────────────────

/**
 * `label` provides domain separation so a proof from one direction can never be
 * reflected back as a valid proof for the other.
 */
export async function proof(
  pairingSecret: Uint8Array,
  label: string,
  transcript: string,
): Promise<string> {
  const key = await subtle.importKey(
    'raw',
    pairingSecret as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', key, enc.encode(`${label}|${transcript}`) as BufferSource);
  return toB64(new Uint8Array(sig));
}

/** Constant-time compare. Length is not secret here, but the contents are. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function fingerprint(input: Uint8Array): Promise<string> {
  const hash = await subtle.digest('SHA-256', input as BufferSource);
  return toB64(new Uint8Array(hash).slice(0, 16));
}
