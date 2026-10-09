import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Bridge } from '../bridge.js';
import { text, pageText, error, notConnected } from './reply.js';

export function registerTabTools(server: McpServer, bridge: Bridge): void {
  server.registerTool(
    'list_tabs',
    {
      description:
        'List all open browser tabs with their IDs, URLs, and titles. Every page tool takes a tabId from this list, so several tabs can be worked side by side without switching.',
      inputSchema: z.object({}),
    },
    async () => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('list_tabs')) as Array<{
          id: number;
          url: string;
          title: string;
          active: boolean;
        }>;
        const lines = data.map(
          (t) => `${t.active ? '→ ' : '  '}[${t.id}] ${t.title} (${t.url})`,
        );
        return pageText(bridge, lines.join('\n'), 'Open tabs. Titles and URLs are reported by the pages themselves:');
      } catch (err) {
        return error(err, bridge);
      }
    },
  );

  server.registerTool(
    'switch_tab',
    {
      description: 'Switch to a specific browser tab by its ID (from list_tabs). Not needed to act on another tab: pass tabId to the tool instead.',
      inputSchema: z.object({
        tabId: z.number().describe('Tab ID to switch to'),
      }),
    },
    async ({ tabId }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('switch_tab', { tabId })) as { url: string; title: string };
        return pageText(bridge, `${data.title}\n${data.url}`, 'Switched tab. Page-reported title and URL:');
      } catch (err) {
        return error(err, bridge);
      }
    },
  );

  server.registerTool(
    'new_tab',
    {
      description: 'Open a new browser tab, optionally navigating to a URL. Returns its id, which every page tool accepts as tabId.',
      inputSchema: z.object({
        url: z.string().optional().describe('URL to open in the new tab'),
      }),
    },
    async ({ url }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('new_tab', { url })) as { tabId: number; url: string; title: string };
        return pageText(bridge, `${data.title}\n${data.url}`, `Opened tab [${data.tabId}]. Page-reported title and URL:`);
      } catch (err) {
        return error(err, bridge);
      }
    },
  );

  server.registerTool(
    'close_tab',
    {
      description: 'Close a browser tab. Closes the current tab if no ID is specified.',
      inputSchema: z.object({
        tabId: z.number().optional().describe('Tab ID to close (current tab if omitted)'),
      }),
    },
    async ({ tabId }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        await bridge.sendCommand('close_tab', { tabId });
        return text(bridge, 'Tab closed.');
      } catch (err) {
        return error(err, bridge);
      }
    },
  );
}
