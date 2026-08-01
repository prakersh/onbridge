import { McpServer } from '@modelcontextprotocol/server';
import { Bridge } from './bridge.js';
import { registerNavigationTools } from './tools/navigation.js';
import { registerObservationTools } from './tools/observation.js';
import { registerInteractionTools } from './tools/interaction.js';
import { registerTabTools } from './tools/tabs.js';
import { registerAdvancedTools } from './tools/advanced.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'onbridge',
    version: '0.1.0',
  });

  const bridge = new Bridge();

  registerNavigationTools(server, bridge);
  registerObservationTools(server, bridge);
  registerInteractionTools(server, bridge);
  registerTabTools(server, bridge);
  registerAdvancedTools(server, bridge);

  return server;
}
