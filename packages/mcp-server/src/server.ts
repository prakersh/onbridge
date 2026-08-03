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

  const bridge = new Bridge();

  registerNavigationTools(server, bridge);
  registerObservationTools(server, bridge);
  registerInteractionTools(server, bridge);
  registerTabTools(server, bridge);
  registerAdvancedTools(server, bridge);
  registerGovernanceTools(server, bridge);

  return server;
}
