import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { serializeSnapshot } from '@onbridge/shared';
import type { Bridge } from '../bridge.js';
import { text, pageText, image, error, notConnected } from './reply.js';

export function registerAdvancedTools(server: McpServer, bridge: Bridge): void {
  server.registerTool(
    'evaluate',
    {
      description:
        'Execute JavaScript in the page context. If ref is provided, the element is available as "element" in the script. Returns the script result as JSON.',
      inputSchema: z.object({
        script: z.string().describe('JavaScript code to execute'),
        ref: z.number().optional().describe('Element ref — available as "element" in the script'),
      }),
    },
    async ({ script, ref }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('evaluate', { script, ref })) as { result: unknown };
        const formatted = typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2);
        return text(bridge, formatted);
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'wait',
    {
      description:
        'Wait for a condition: text to appear, text to disappear, or a CSS selector to match an element. Default timeout 10 seconds.',
      inputSchema: z.object({
        text: z.string().optional().describe('Wait for this text to appear on the page'),
        textGone: z.string().optional().describe('Wait for this text to disappear from the page'),
        selector: z.string().optional().describe('Wait for an element matching this CSS selector'),
        timeout: z.number().optional().describe('Max wait time in milliseconds (default 10000)'),
      }),
    },
    async ({ text: waitText, textGone, selector, timeout }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('wait', {
          text: waitText,
          textGone,
          selector,
          timeout,
        })) as { success: boolean; elapsed: number };
        return text(bridge, `Condition met after ${data.elapsed}ms.`);
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'get_cookies',
    {
      description:
        'List cookies for the current page or a domain. Values are withheld by default — you get names, domains and flags, which is enough to tell whether a session exists. ' +
        'Set includeValues only if the task genuinely cannot proceed without them: cookie values are live credentials, the user must approve releasing them, and they persist in this transcript afterwards.',
      inputSchema: z.object({
        domain: z.string().optional().describe('Filter cookies by domain'),
        includeValues: z
          .boolean()
          .optional()
          .describe('Request the actual values. Requires explicit user approval.'),
      }),
    },
    async ({ domain, includeValues }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('get_cookies', { domain, includeValues })) as {
          cookies: Array<Record<string, unknown>>;
          redacted: boolean;
          note?: string;
        };
        if (!data.cookies?.length) return text(bridge, 'No cookies found.');

        const lines = data.cookies.slice(0, 50).map((c) => {
          const flags = [c.secure && 'secure', c.httpOnly && 'httpOnly', c.session && 'session']
            .filter(Boolean)
            .join(' ');
          const val = data.redacted ? `<hidden, ${c.valueLength} chars>` : `=${c.value}`;
          return `${c.name}${val} (${c.domain})${flags ? ` [${flags}]` : ''}`;
        });
        if (data.cookies.length > 50) lines.push(`... and ${data.cookies.length - 50} more`);
        if (data.note) lines.push('', data.note);
        return text(bridge, lines.join('\n'));
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'set_cookie',
    {
      description: 'Set a browser cookie.',
      inputSchema: z.object({
        name: z.string().describe('Cookie name'),
        value: z.string().describe('Cookie value'),
        domain: z.string().describe('Cookie domain'),
      }),
    },
    async ({ name, value, domain }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        await bridge.sendCommand('set_cookie', { name, value, domain });
        return text(bridge, `Cookie "${name}" set for ${domain}.`);
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'console_logs',
    {
      description: 'Get browser console messages, optionally filtered by severity level.',
      inputSchema: z.object({
        level: z.enum(['error', 'warning', 'info', 'debug']).optional().describe('Minimum log level to include'),
      }),
    },
    async ({ level }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const raw = (await bridge.sendCommand('console_logs', { level })) as { logs: Array<{ level: string; text: string; timestamp: number }> } | Array<{ level: string; text: string; timestamp: number }>;
        const data = Array.isArray(raw) ? raw : (raw.logs ?? []);
        if (data.length === 0) return text(bridge, 'No console messages.');
        const lines = data.slice(0, 50).map((m) => `[${m.level}] ${m.text}`);
        if (data.length > 50) lines.push(`... and ${data.length - 50} more`);
        return text(bridge, lines.join('\n'));
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'dom_query',
    {
      description: 'Query the DOM using a CSS selector. Works without eval (CSP-safe). Actions: "list" returns matching elements, "click" clicks the nth match, "text" returns full text of nth match.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector (e.g., "#add-to-cart-button", ".price", "button[type=submit]")'),
        action: z.enum(['list', 'click', 'text']).optional().describe('What to do with matches (default: list)'),
        index: z.number().optional().describe('Which match to target for click/text (default: 0 = first)'),
      }),
    },
    async ({ selector, action, index }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = await bridge.sendCommand('dom_query', { selector, action, index });
        if (action === 'click') {
          return text(bridge, serializeSnapshot(data as any));
        }
        if (action === 'text') {
          return text(bridge, (data as any).text ?? '');
        }
        const result = data as { matches: number; results: Array<{ index: number; ref?: number; tag: string; text: string; id?: string }> };
        const lines = [`${result.matches} match${result.matches === 1 ? '' : 'es'}:`];
        for (const r of result.results) {
          lines.push(`  [${r.index}] <${r.tag}>${r.ref ? ` ref:${r.ref}` : ''}${r.id ? ` #${r.id}` : ''} "${r.text}"`);
        }
        return text(bridge, lines.join('\n'));
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'download_file',
    {
      description: 'Download a file from a URL or by clicking a download link element. Returns the filename and local path after download completes.',
      inputSchema: z.object({
        url: z.string().optional().describe('Direct URL to download'),
        ref: z.number().optional().describe('Ref of a link element to download from'),
      }),
    },
    async ({ url, ref }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('download_file', { url, ref })) as { filename: string; path: string };
        return text(bridge, `Downloaded: ${data.filename}\nPath: ${data.path}`);
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'list_downloads',
    {
      description: 'List recent browser downloads with their filenames, paths, and status.',
      inputSchema: z.object({
        limit: z.number().optional().describe('Max number of downloads to return (default 10)'),
      }),
    },
    async ({ limit }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('list_downloads', { limit })) as Array<{
          filename: string;
          path: string;
          state: string;
          size: number;
          url: string;
        }>;
        if (data.length === 0) return text(bridge, 'No downloads found.');
        const lines = data.map(
          (d) => `${d.state === 'complete' ? '✓' : '…'} ${d.filename} (${(d.size / 1024).toFixed(0)}KB) — ${d.path}`,
        );
        return text(bridge, lines.join('\n'));
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'activity_log',
    {
      description: 'Get the recent command history — what actions the agent has taken, their success/failure, errors, and timing. Useful for self-diagnosis.',
      inputSchema: z.object({}),
    },
    async () => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('activity_log', {})) as {
          entries: Array<{ action: string; summary: string; success: boolean; error?: string; timing: number; timestamp: number }>;
          totalCommands: number;
        };
        if (data.entries.length === 0) return text(bridge, 'No commands executed yet.');
        const lines = [`Total commands: ${data.totalCommands}\n`];
        for (const e of data.entries) {
          const status = e.success ? '✓' : '✗';
          const err = e.error ? ` — ${e.error}` : '';
          lines.push(`${status} ${e.action} ${e.summary} (${e.timing}ms)${err}`);
        }
        return text(bridge, lines.join('\n'));
      } catch (err) {
        return error(err);
      }
    },
  );
}

