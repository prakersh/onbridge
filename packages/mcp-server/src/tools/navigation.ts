import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { serializeSnapshot } from '@onbridge/shared';
import type { PageSnapshot } from '@onbridge/shared';
import type { Bridge } from '../bridge.js';

export function registerNavigationTools(server: McpServer, bridge: Bridge): void {
  server.registerTool(
    'navigate',
    {
      description: 'Navigate to a URL in the browser. Waits for page load and returns a compact page snapshot with interactive element refs.',
      inputSchema: z.object({
        url: z.string().describe('The URL to navigate to'),
      }),
    },
    async ({ url }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('navigate', { url })) as PageSnapshot;
        return text(serializeSnapshot(data));
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'back',
    {
      description: 'Go back to the previous page in browser history.',
      inputSchema: z.object({}),
    },
    async () => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('back')) as { url: string; title: string };
        return text(`Navigated back to: ${data.title} (${data.url})`);
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'forward',
    {
      description: 'Go forward to the next page in browser history.',
      inputSchema: z.object({}),
    },
    async () => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('forward')) as { url: string; title: string };
        return text(`Navigated forward to: ${data.title} (${data.url})`);
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'reload',
    {
      description: 'Reload the current page.',
      inputSchema: z.object({
        hard: z.boolean().optional().describe('If true, bypass cache'),
      }),
    },
    async ({ hard }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('reload', { hard })) as { url: string; title: string };
        return text(`Reloaded: ${data.title} (${data.url})`);
      } catch (err) {
        return error(err);
      }
    },
  );
}

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

function error(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
}

function notConnected() {
  return {
    content: [{ type: 'text' as const, text: 'Extension not connected. Enable control mode in the onbridge browser extension.' }],
    isError: true,
  };
}
