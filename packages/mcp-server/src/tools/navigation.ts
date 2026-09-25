import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ActionResult } from '@onbridge/shared';
import type { Bridge } from '../bridge.js';
import { pageText, error, notConnected, actionReply } from './reply.js';

export function registerNavigationTools(server: McpServer, bridge: Bridge): void {
  server.registerTool(
    'navigate',
    {
      description:
        'Navigate to a URL. Waits for the page to load, then returns where it ended up plus a page snapshot with ' +
        'interactive element refs. On a heavy page that snapshot is most of the cost of the call: if you only need ' +
        'to READ the page, pass snapshot:false and follow with extract_text or find, which is far cheaper. ' +
        'Use compact/depth to trim the snapshot the same way the snapshot tool does.',
      inputSchema: z.object({
        url: z.string().describe('The URL to navigate to'),
        snapshot: z
          .boolean()
          .optional()
          .describe('Return a page snapshot (default true). Set false for just the URL and title.'),
        compact: z
          .boolean()
          .optional()
          .describe('Compact snapshot: skip nav/footer/ads. Reduces size by ~70% on e-commerce sites.'),
        depth: z.number().optional().describe('Max nesting depth to capture in the snapshot'),
      }),
    },
    async ({ url, snapshot, compact, depth }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('navigate', {
          url,
          snapshot,
          compact,
          depth,
        })) as ActionResult;
        return actionReply(bridge, data, `Navigated to ${url}.`);
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
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('back')) as { url: string; title: string };
        return pageText(bridge, `${data.title}\n${data.url}`, 'Navigated back. Page-reported title and URL:');
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
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('forward')) as { url: string; title: string };
        return pageText(bridge, `${data.title}\n${data.url}`, 'Navigated forward. Page-reported title and URL:');
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
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('reload', { hard })) as { url: string; title: string };
        return pageText(bridge, `${data.title}\n${data.url}`, 'Reloaded. Page-reported title and URL:');
      } catch (err) {
        return error(err);
      }
    },
  );
}

