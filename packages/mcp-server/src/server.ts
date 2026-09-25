import { CLIENT_INFO_META_KEY, McpServer } from '@modelcontextprotocol/server';
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

/**
 * The `clientInfo` a request carried in its `_meta` envelope (protocol revision 2026-07-28), found on the handler context the SDK passes alongside the arguments.
 */
function clientInfoFrom(args: unknown[]): { name?: string; version?: string; title?: string } | undefined {
  for (const a of args) {
    const envelope = (a as { mcpReq?: { envelope?: Record<string, unknown> } } | null)?.mcpReq?.envelope;
    const info = envelope?.[CLIENT_INFO_META_KEY];
    if (info && typeof info === 'object') {
      const { name, version, title } = info as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      return { name: str(name), version: str(version), title: str(title) };
    }
  }
  return undefined;
}

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

  // Every tool call is the agent asking for the browser, so each one first makes sure the bridge is listening and gives the browser a moment to connect. Wrapped once here rather than in forty handlers, so a new tool cannot forget it.
  const registerTool = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: unknown, handler: (...args: unknown[]) => unknown) =>
    registerTool(name, config as never, (async (...args: unknown[]) => {
      // Read before connecting, so the pairing prompt that this call may cause already names the agent correctly.
      const info = clientInfoFrom(args);
      if (info) bridge.noteClientInfo(info);
      await bridge.connectOnDemand();
      return handler(...args);
    }) as never)) as typeof server.registerTool;

  registerNavigationTools(server, bridge);
  registerObservationTools(server, bridge);
  registerInteractionTools(server, bridge);
  registerTabTools(server, bridge);
  registerAdvancedTools(server, bridge);
  registerGovernanceTools(server, bridge);

  return server;
}
