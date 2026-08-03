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
    'extract_text',
    {
      description:
        'Read the page as text, with tables rendered as markdown. Use this when you need to READ content — an article, a results table, a description — rather than act on it. ' +
        'Far cheaper than a snapshot, which spends most of its tokens describing structure you do not need for reading. Pass a ref to read just that section.',
      inputSchema: z.object({
        ref: z.number().optional().describe('Read only this element and its descendants'),
        maxChars: z.number().optional().describe('Truncate beyond this many characters (default 20000)'),
      }),
    },
    async ({ ref, maxChars }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('extract_text', { ref, maxChars })) as {
          text: string;
          truncated: boolean;
          chars: number;
        };
        const suffix = data.truncated
          ? `\n\n[truncated — ${data.chars} characters total; re-read a specific section with ref]`
          : '';
        return pageText(bridge, data.text + suffix);
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'list_actions',
    {
      description:
        'List just the interactive elements on the page — buttons, links, inputs — with their refs, without the surrounding tree. ' +
        'Use it to answer "what can I do here?" when you do not need full page structure. Much smaller than a snapshot.',
      inputSchema: z.object({}),
    },
    async () => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('list_actions')) as {
          actions: Array<Record<string, unknown>>;
        };
        if (!data.actions?.length) return pageText(bridge, 'No interactive elements found.');
        const lines = data.actions.map((a) => {
          const bits = [
            `[${a.tag}${a.type ? `:${a.type}` : ''}:${a.ref}]`,
            a.label ? `"${a.label}"` : '',
            a.disabled ? '(disabled)' : '',
            a.inViewport ? '' : '(off-screen)',
          ].filter(Boolean);
          return bits.join(' ');
        });
        return pageText(bridge, lines.join('\n'));
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'highlight',
    {
      description:
        'Briefly outline an element in the page so the watching user can see what you are about to act on. Purely visual — it changes nothing.',
      inputSchema: z.object({
        ref: z.number().describe('Element ref to outline'),
        durationMs: z.number().optional().describe('How long to show it (default 2000)'),
      }),
    },
    async ({ ref, durationMs }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        await bridge.sendCommand('highlight', { ref, durationMs });
        return text(bridge, `Highlighted element ${ref}.`);
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

