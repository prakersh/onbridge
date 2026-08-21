import { McpServer } from '@modelcontextprotocol/server';
import { Bridge } from './bridge.js';
import { registerNavigationTools } from './tools/navigation.js';
import { registerObservationTools } from './tools/observation.js';
import { registerInteractionTools } from './tools/interaction.js';
import { registerTabTools } from './tools/tabs.js';
import { registerAdvancedTools } from './tools/advanced.js';
import { registerGovernanceTools } from './tools/governance.js';

/**
 * Injected at build time from package.json, which `./app.sh --bump` keeps in
 * sync. Hardcoding it here let the reported version drift to a stale 0.1.0.
 * The fallback covers `tsx` dev runs, where no define is applied.
 */
declare const __ONBRIDGE_VERSION__: string | undefined;
const VERSION = typeof __ONBRIDGE_VERSION__ === 'string' ? __ONBRIDGE_VERSION__ : '0.0.0-dev';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'onbridge',
    version: VERSION,
  });

  const bridge = new Bridge(VERSION);

  // The agent client introduces itself in `initialize`. This is the only
  // authoritative answer to "which agent is this", and the extension shows it in
  // the pairing prompt — so a user approving access knows what they are
  // approving instead of being asked about "an AI agent".
  bridge.setClientInfoSource(() => server.server.getClientVersion());
  // Only a nudge to redraw an already-connected panel. Identity itself does not
  // depend on this firing, because some clients never send the notification.
  server.server.oninitialized = () => bridge.refreshIdentity();

  // Tear the bridge down when the agent goes away, or the WebSocketServer keeps
  // the event loop alive and the process lingers forever holding its port — a
  // zombie the extension keeps rediscovering as a live-looking session that
  // never answers. `npx onbridge` respawns constantly, so this is the common
  // path, not an edge case: without it, ten exited runs exhaust the whole port
  // range and onbridge stops working entirely.
  //
  // Two independent triggers because neither alone is reliable: the SDK's stdio
  // transport only listens for stdin 'data'/'error', so a clean pipe close
  // (stdin 'end') never reaches `server.server.onclose`; and a kill signal never
  // touches stdin at all.
  let closed = false;
  const shutdown = (code = 0) => {
    if (closed) return;
    closed = true;
    bridge.close();
    process.exit(code);
  };
  server.server.onclose = () => shutdown(0);
  process.stdin.once('end', () => shutdown(0));
  process.stdin.once('close', () => shutdown(0));
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));

  registerNavigationTools(server, bridge);
  registerObservationTools(server, bridge);
  registerInteractionTools(server, bridge);
  registerTabTools(server, bridge);
  registerAdvancedTools(server, bridge);
  registerGovernanceTools(server, bridge);

  return server;
}
