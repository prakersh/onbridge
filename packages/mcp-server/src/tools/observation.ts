import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { serializeSnapshot, serializeFindResults } from '@onbridge/shared';
import type { PageSnapshot, FindResult } from '@onbridge/shared';
import type { Bridge } from '../bridge.js';
import { text, pageText, image, error, notConnected } from './reply.js';

export function registerObservationTools(server: McpServer, bridge: Bridge): void {
  server.registerTool(
    'snapshot',
    {
      description:
        'Capture a compact DOM tree of the current page. Interactive elements get numeric refs (use with click/type/fill_form/etc). Use target ref to scope to a subtree, depth to limit nesting. This is the primary way to see what is on the page.',
      inputSchema: z.object({
        target: z.number().optional().describe('Ref number to scope snapshot to a subtree'),
        depth: z.number().optional().describe('Max nesting depth to capture'),
        compact: z.boolean().optional().describe('Compact mode: skip nav/footer/ads, show only main content. Reduces snapshot size by ~70% on e-commerce sites.'),
      }),
    },
    async ({ target, depth, compact }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('snapshot', { target, depth, compact })) as PageSnapshot;
        return pageText(bridge, serializeSnapshot(data));
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'find',
    {
      description:
        'Search the page for elements matching text, role, or CSS selector. Returns matching elements with ref numbers and surrounding context. More token-efficient than a full snapshot when you know what you are looking for.',
      inputSchema: z.object({
        text: z.string().optional().describe('Text to search for (case-insensitive substring match)'),
        role: z.string().optional().describe('Filter by element role (button, link, textbox, etc)'),
        selector: z.string().optional().describe('CSS selector to match elements'),
      }),
    },
    async ({ text: searchText, role, selector }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('find', { text: searchText, role, selector })) as FindResult[];
        return pageText(bridge, serializeFindResults(data));
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'screenshot',
    {
      description: 'Take a screenshot of the current page. Use snapshot for interacting with elements — screenshots are for visual verification only.',
      inputSchema: z.object({
        fullPage: z.boolean().optional().describe('Capture the full scrollable page'),
        quality: z.number().optional().describe('JPEG quality 0-100 (default 60)'),
      }),
    },
    async ({ fullPage, quality }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('screenshot', { fullPage, quality })) as { base64: string };
        return image(bridge, data.base64);
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'get_text',
    {
      description: 'Get the full, untruncated text content of an element by its ref number.',
      inputSchema: z.object({
        ref: z.number().describe('Element ref number from snapshot or find'),
      }),
    },
    async ({ ref }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('get_text', { ref })) as { text: string };
        return pageText(bridge, data.text);
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'get_url',
    {
      description: 'Get the current page URL and title.',
      inputSchema: z.object({}),
    },
    async () => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('get_url')) as { url: string; title: string };
        return text(bridge, `${data.title}\n${data.url}`);
      } catch (err) {
        return error(err);
      }
    },
  );
}

