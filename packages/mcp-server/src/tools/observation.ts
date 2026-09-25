import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { serializeSnapshot, serializeFindResults } from '@onbridge/shared';
import type { PageSnapshot, FindResult, ExtractTextResult } from '@onbridge/shared';
import type { Bridge } from '../bridge.js';
import { text, pageText, image, error, notConnected, recordView } from './reply.js';

export function registerObservationTools(server: McpServer, bridge: Bridge): void {
  server.registerTool(
    'snapshot',
    {
      description:
        'Capture a compact DOM tree of the current page. Interactive elements get numeric refs (use with ' +
        'click/type/fill_form/etc). Use target ref to scope to a subtree, depth to limit nesting. ' +
        'This is the tool for ACTING on a page — it is also the most expensive one here, because most of what it ' +
        'returns is structure. If you only need to read the page, use extract_text; if you know what you are ' +
        'looking for, use find. Reach for those first and snapshot when you need refs. ' +
        'Always returns the whole page, so call it when you no longer have the page view an action reply refers to.',
      inputSchema: z.object({
        target: z.number().optional().describe('Ref number to scope snapshot to a subtree'),
        depth: z.number().optional().describe('Max nesting depth to capture'),
        compact: z.boolean().optional().describe('Compact mode: skip nav/footer/ads, show only main content. Reduces snapshot size by ~70% on e-commerce sites.'),
      }),
    },
    async ({ target, depth, compact }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('snapshot', { target, depth, compact })) as PageSnapshot;
        const page = serializeSnapshot(data);
        // A scoped snapshot is not the whole page, so later changes are never described against it.
        if (target != null) return pageText(bridge, page);
        return pageText(bridge, page, `This is page view ${recordView(bridge, data?.url ?? '', page)}.`);
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'find',
    {
      description:
        'Search the page for elements matching text, role, or CSS selector. Returns matching elements with ref numbers, ' +
        'surrounding context, and — for links — the absolute href, so you can navigate straight to a result instead of ' +
        'clicking through it. More token-efficient than a full snapshot when you know what you are looking for.',
      inputSchema: z.object({
        text: z.string().optional().describe('Text to search for (case-insensitive substring match)'),
        role: z.string().optional().describe('Filter by element role (button, link, textbox, etc)'),
        selector: z.string().optional().describe('CSS selector to match elements'),
      }),
    },
    async ({ text: searchText, role, selector }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
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
      if (!bridge.isConnected()) return notConnected(bridge);
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
      if (!bridge.isConnected()) return notConnected(bridge);
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
        'Far cheaper than a snapshot, which spends most of its tokens describing structure you do not need for reading. Pass a ref to read just that section. ' +
        'Long text comes in parts: a reply that stops early says so, with the offset to continue from.',
      inputSchema: z.object({
        ref: z.number().optional().describe('Read only this element and its descendants'),
        offset: z.number().optional().describe('Start at this character, to continue where an earlier reply stopped'),
        maxChars: z.number().optional().describe('Characters in one reply (default 20000)'),
      }),
    },
    async ({ ref, offset, maxChars }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const start = Math.max(0, Math.floor(offset ?? 0));
        const limit = Math.max(1, Math.floor(maxChars ?? 20_000));
        // The extension reads from the start, so asking it for start + limit and slicing here pages the text with no extension change.
        const data = (await bridge.sendCommand('extract_text', { ref, maxChars: start + limit })) as ExtractTextResult;

        // A bare "" used to cover three different answers — the element has no
        // text, the ref names nothing, and the reader failed — and an agent
        // reasonably reads all three as "this section of the page is empty".
        // Each says what it is now.
        if (data.error === 'ref-not-found') {
          return text(
            bridge,
            `No element with ref ${ref} is on the page any more. Take a fresh snapshot or find, ` +
              'then read the new ref.',
          );
        }
        if (data.empty) {
          return text(
            bridge,
            ref != null
              ? `Element ${ref} is on the page but has no readable text. It may be an image, an ` +
                  'icon, or a container whose content has not loaded. Read a parent, or snapshot it.'
              : 'The page has no readable text yet.',
          );
        }

        const total = Number(data.chars) || data.text.length;
        if (start >= total) {
          return text(bridge, `The text is ${total} characters long, so offset ${start} is past its end.`);
        }
        let part = data.text.slice(start, start + limit);
        let end = start + part.length;
        const more = end < total;
        if (more) {
          // End on a line break when one is near, so a sentence or table row is not split across two replies.
          const cut = part.lastIndexOf('\n');
          if (cut > part.length * 0.8) {
            part = part.slice(0, cut);
            end = start + cut + 1;
          }
        }
        // Outside the fence and never silent: an agent that is not told the text stopped reads the end of the reply as the end of the page.
        const where = `Characters ${start}–${end} of ${total}.`;
        const next = ref != null ? `offset: ${end}, ref: ${ref}` : `offset: ${end}`;
        const note = more
          ? `${where} The text continues: call extract_text with ${next} for the next part.`
          : start > 0
            ? `${where} This is the end of the text.`
            : undefined;
        return pageText(bridge, part, note);
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
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('list_actions')) as {
          actions: Array<Record<string, unknown>>;
        };
        if (!data.actions?.length) return pageText(bridge, 'No interactive elements found.');
        const lines = data.actions.map((a) => {
          const bits = [
            `[${a.tag}${a.type ? `:${a.type}` : ''}:${a.ref}]`,
            a.label ? `"${a.label}"` : '',
            a.href ? `→ ${a.href}` : '',
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
      if (!bridge.isConnected()) return notConnected(bridge);
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
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('get_url')) as { url: string; title: string };
        return pageText(bridge, `${data.title}\n${data.url}`, 'Page-reported title and URL:');
      } catch (err) {
        return error(err);
      }
    },
  );
}

