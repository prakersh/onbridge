import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
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
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('evaluate', { script, ref })) as { result: unknown };
        const formatted = typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2);
        return pageText(bridge, formatted, 'Result of evaluating your script in the page:');
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
      if (!bridge.isConnected()) return notConnected(bridge);
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
      if (!bridge.isConnected()) return notConnected(bridge);
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
        return pageText(bridge, lines.join('\n'), 'Cookies for this page. Names and domains are set by the site:');
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
      if (!bridge.isConnected()) return notConnected(bridge);
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
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const raw = (await bridge.sendCommand('console_logs', { level })) as { logs: Array<{ level: string; text: string; timestamp: number }> } | Array<{ level: string; text: string; timestamp: number }>;
        const data = Array.isArray(raw) ? raw : (raw.logs ?? []);
        if (data.length === 0) return text(bridge, 'No console messages.');
        const lines = data.slice(0, 50).map((m) => `[${m.level}] ${m.text}`);
        if (data.length > 50) lines.push(`... and ${data.length - 50} more`);
        return pageText(bridge, lines.join('\n'), 'Console output. Any page can write whatever it likes here:');
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'network_requests',
    {
      description:
        'List recent network activity for the current tab: method, status, URL, type, size and timing, plus a requestId usable with network_request_body. ' +
        'Sensitive header values (authorization, cookies and the like) are redacted before they reach you.',
      inputSchema: z.object({
        urlFilter: z.string().optional().describe('Only requests whose URL contains this substring'),
        method: z.string().optional().describe('Only requests with this HTTP method'),
        status: z.number().optional().describe('Only responses with this HTTP status code'),
        limit: z.number().optional().describe('Max entries to return (default 50)'),
        failedOnly: z.boolean().optional().describe('Only requests that failed'),
      }),
    },
    async ({ urlFilter, method, status, limit, failedOnly }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('network_requests', {
          urlFilter,
          method,
          status,
          limit,
          failedOnly,
        })) as {
          entries: Array<{
            requestId: string;
            url: string;
            method: string;
            resourceType?: string;
            status?: number;
            statusText?: string;
            mimeType?: string;
            requestHeaders?: Record<string, string>;
            responseHeaders?: Record<string, string>;
            encodedDataLength?: number;
            startedAt: number;
            endedAt?: number;
            failed?: boolean;
            fromCache?: boolean;
          }>;
          total: number;
        };
        if (!data.entries?.length) return text(bridge, 'No network requests recorded.');

        const lines: string[] = [];
        for (const e of data.entries) {
          const outcome = e.failed ? '✗' : (e.status ?? '…');
          const extras = [
            e.resourceType,
            e.mimeType,
            e.encodedDataLength != null && `${(e.encodedDataLength / 1024).toFixed(1)}KB`,
            e.endedAt != null && `${Math.round(e.endedAt - e.startedAt)}ms`,
            e.fromCache && 'cache',
          ]
            .filter(Boolean)
            .join(', ');
          lines.push(
            `${e.method} ${outcome}${e.statusText ? ` ${e.statusText}` : ''} ${e.url} [${e.requestId}]${extras ? ` (${extras})` : ''}`,
          );
          for (const [k, v] of Object.entries(e.requestHeaders ?? {})) lines.push(`  > ${k}: ${v}`);
          for (const [k, v] of Object.entries(e.responseHeaders ?? {})) lines.push(`  < ${k}: ${v}`);
        }
        if (data.total > data.entries.length) {
          lines.push(`... ${data.total - data.entries.length} more not shown`);
        }
        return pageText(
          bridge,
          lines.join('\n'),
          'Network activity. URLs, headers and status text are chosen by pages and servers:',
        );
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'network_request_body',
    {
      description:
        'Fetch the response body of one request, by requestId from network_requests. Kept separate from the listing on purpose: ' +
        'bodies can contain credentials and personal data, so retrieving one is gated at a higher risk level than browsing the request list.',
      inputSchema: z.object({
        requestId: z.string().describe('The requestId reported by network_requests'),
      }),
    },
    async ({ requestId }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('network_request_body', { requestId })) as {
          body?: string;
          base64Encoded?: boolean;
          mimeType?: string;
        } | null;
        if (typeof data?.body !== 'string') {
          return text(
            bridge,
            'Response body is no longer available — the browser only retains bodies briefly, and navigation discards them.',
          );
        }
        const MAX_BODY_CHARS = 20_000;
        const truncated = data.body.length > MAX_BODY_CHARS;
        const shown = truncated ? data.body.slice(0, MAX_BODY_CHARS) : data.body;
        const facts = [
          data.mimeType,
          data.base64Encoded && 'base64-encoded',
          truncated && `truncated to ${MAX_BODY_CHARS} of ${data.body.length} chars`,
        ]
          .filter(Boolean)
          .join(', ');
        return pageText(bridge, shown, `Response body${facts ? ` (${facts})` : ''}:`);
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'dom_query',
    {
      description:
        'Query the DOM using a CSS selector (read-only, CSP-safe, no eval). Actions: "list" returns matching elements ' +
        '(with the absolute href for links), "text" returns the full text of the nth match, "attr" returns one ' +
        'attribute across every match — use it to read hrefs from a result list and navigate to them directly, which ' +
        'avoids clicking through. To click a match, use the "click" tool with a ref from a snapshot, or "click_by_text".',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector (e.g., "#add-to-cart-button", ".price", "button[type=submit]")'),
        action: z
          .enum(['list', 'text', 'attr'])
          .optional()
          .describe('What to do with matches (default: list)'),
        attr: z
          .string()
          .optional()
          .describe('Attribute to read for "attr" (default: href). href and src come back absolute.'),
        index: z.number().optional().describe('Which match to read for "text" (default: 0 = first)'),
      }),
    },
    async ({ selector, action, attr, index }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = await bridge.sendCommand('dom_query', { selector, action, attr, index });
        if (action === 'text') {
          return pageText(bridge, (data as any).text ?? '');
        }
        if (action === 'attr') {
          const res = data as {
            matches: number;
            attr: string;
            values: Array<{ index: number; tag: string; value: string | null; text: string }>;
          };
          const lines = [`${res.matches} match${res.matches === 1 ? '' : 'es'}, ${res.attr}:`];
          for (const v of res.values) {
            lines.push(`  [${v.index}] <${v.tag}> ${v.value ?? '(none)'}${v.text ? ` — "${v.text}"` : ''}`);
          }
          return pageText(bridge, lines.join('\n'));
        }
        const result = data as { matches: number; results: Array<{ index: number; ref?: number; tag: string; text: string; id?: string; href?: string }> };
        const lines = [`${result.matches} match${result.matches === 1 ? '' : 'es'}:`];
        for (const r of result.results) {
          lines.push(
            `  [${r.index}] <${r.tag}>${r.ref ? ` ref:${r.ref}` : ''}${r.id ? ` #${r.id}` : ''} "${r.text}"` +
              (r.href ? ` → ${r.href}` : ''),
          );
        }
        return pageText(bridge, lines.join('\n'));
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
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('download_file', { url, ref })) as { filename: string; path: string };
        return pageText(bridge, `${data.filename}\n${data.path}`, 'Downloaded. Filename and path come from the remote server:');
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
      if (!bridge.isConnected()) return notConnected(bridge);
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
        return pageText(bridge, lines.join('\n'), 'Downloads. Filenames come from the remote servers:');
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
      if (!bridge.isConnected()) return notConnected(bridge);
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
        return pageText(bridge, lines.join('\n'), 'Recent commands. Element labels in it are page text:');
      } catch (err) {
        return error(err);
      }
    },
  );
}

