import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ASK_USER_TIMEOUT_MS } from '@onbridge/shared';
import type { Bridge } from '../bridge.js';
import { text, error, notConnected } from './reply.js';

export function registerGovernanceTools(server: McpServer, bridge: Bridge): void {
  server.registerTool(
    'ask_user',
    {
      description:
        'Ask the user a question and wait for their answer. The question appears in the onbridge side panel next to the page you are working on, so the user can answer without leaving the browser. ' +
        'Use this when you need a decision you should not make alone — which of several results to pick, whether details you found are correct, how to handle something ambiguous. ' +
        'Blocks until the user answers or ~110s passes; on timeout it returns without an answer and you may retry or proceed. ' +
        'Do not use it for actions that need permission — those are gated automatically.',
      inputSchema: z.object({
        question: z.string().describe('The question to show the user. Be specific and self-contained.'),
        options: z
          .array(z.string())
          .optional()
          .describe('Optional choices to render as buttons. The user may still type a free-form reply.'),
      }),
    },
    async ({ question, options }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand(
          'ask_user',
          { question, options },
          undefined,
          ASK_USER_TIMEOUT_MS,
        )) as { answer?: string; timedOut?: boolean };

        if (data.timedOut || !data.answer) {
          return text(
            bridge,
            'No answer yet — the user has not responded. You may ask again, or proceed and tell them what you assumed.',
          );
        }
        return text(bridge, `The user answered: ${data.answer}`);
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'bridge_status',
    {
      description:
        'Check whether the browser extension is connected and what it will currently allow. Use this first if a browser command fails unexpectedly, to tell a disconnected extension apart from a genuine page problem.',
      inputSchema: z.object({}),
    },
    async () => {
      if (!bridge.isConnected()) {
        return text(
          bridge,
          [
            'Extension: NOT CONNECTED',
            `Bridge listening on: 127.0.0.1:${bridge.getPort() || '(not bound)'}`,
            '',
            'The user needs to enable Control Mode in the onbridge extension.',
            'On first connection they will also be asked to approve pairing once.',
          ].join('\n'),
        );
      }
      try {
        const data = (await bridge.sendCommand('bridge_status')) as Record<string, unknown>;
        const modeNote: Record<string, string> = {
          yolo: 'BYPASS — nothing is gated. Be correspondingly careful.',
          auto: 'Balanced — credential access and real-world actions need the user to approve.',
          strict: 'Ask every step — every navigation and change needs the user to approve.',
        };
        const mode = String(data.approvalMode ?? 'auto');
        const allowlist = (data.allowlist as string[]) ?? [];
        const denylist = (data.denylist as string[]) ?? [];

        return text(
          bridge,
          [
            'Extension: CONNECTED (encrypted, paired)',
            `Bridge port: 127.0.0.1:${bridge.getPort()}`,
            `Access scope: ${data.accessScope ?? 'unknown'}`,
            `Approval mode: ${mode} — ${modeNote[mode] ?? ''}`,
            allowlist.length ? `Allowed sites only: ${allowlist.join(', ')}` : 'Allowed sites: any',
            denylist.length ? `Blocked sites: ${denylist.join(', ')}` : '',
            `Automation: ${data.paused ? 'PAUSED by the user' : 'active'}`,
            data.degraded ? `Input fidelity: DEGRADED (${data.degraded})` : '',
            `Commands this session: ${data.commandCount ?? 0}`,
          ]
            .filter(Boolean)
            .join('\n'),
        );
      } catch (err) {
        return error(err);
      }
    },
  );
}
