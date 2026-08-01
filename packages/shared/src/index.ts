export type { DomNode, PageSnapshot, FindResult, ScrollState } from './dom-types.js';
export type { ServerMessage, ExtensionMessage, CommandAction } from './protocol.js';
export { WS_PORT, HEARTBEAT_INTERVAL_MS, COMMAND_TIMEOUT_MS } from './protocol.js';
export { serializeSnapshot, serializeFindResults } from './serializer.js';
