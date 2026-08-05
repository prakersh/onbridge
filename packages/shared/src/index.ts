export type { DomNode, PageSnapshot, FindResult, ScrollState } from './dom-types.js';
export type { ServerMessage, ExtensionMessage, CommandAction } from './protocol.js';
export {
  WS_PORT,
  WS_PORT_RANGE,
  HEARTBEAT_INTERVAL_MS,
  COMMAND_TIMEOUT_MS,
  ASK_USER_TIMEOUT_MS,
} from './protocol.js';
export { serializeSnapshot, serializeFindResults } from './serializer.js';

export type { EphemeralKeyPair, DerivedKeys, SealedFrame } from './crypto.js';
export {
  toB64,
  fromB64,
  randomBytes,
  generateEphemeralKeyPair,
  deriveSharedSecret,
  deriveHandshakeKeys,
  deriveSessionKey,
  seal,
  open,
  proof,
  safeEqual,
  fingerprint,
} from './crypto.js';

export type { HandshakeFrame, AgentIdentity } from './handshake.js';
export {
  HANDSHAKE_VERSION,
  PROOF_PAIR,
  PROOF_AUTH_EXT,
  PROOF_AUTH_SRV,
  computeSessionId,
  makeProof,
  verifyProof,
  ReplayGuard,
} from './handshake.js';
