import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { serializeSnapshot } from '@onbridge/shared';
import type { PageSnapshot } from '@onbridge/shared';
import type { Bridge } from '../bridge.js';

export function registerInteractionTools(server: McpServer, bridge: Bridge): void {
  server.registerTool(
    'click',
    {
      description: 'Click an element by ref number (from snapshot/find). Returns updated page snapshot.',
      inputSchema: z.object({
        ref: z.number().describe('Element ref number from snapshot or find'),
        button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button'),
        doubleClick: z.boolean().optional().describe('Double-click instead of single'),
      }),
    },
    async ({ ref, button, doubleClick }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('click', { ref, button, doubleClick })) as PageSnapshot;
        return text(serializeSnapshot(data));
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'type',
    {
      description: 'Type text into an input element by ref. Set clear to erase existing text first. Set submit to press Enter after typing.',
      inputSchema: z.object({
        ref: z.number().describe('Element ref number'),
        text: z.string().describe('Text to type'),
        clear: z.boolean().optional().describe('Clear existing text first'),
        submit: z.boolean().optional().describe('Press Enter after typing'),
      }),
    },
    async ({ ref, text: inputText, clear, submit }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        await bridge.sendCommand('type', { ref, text: inputText, clear, submit });
        return text('Typed successfully.');
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'fill_form',
    {
      description: 'Fill multiple form fields at once. Each field identified by ref number and value. Major token saver vs individual type calls.',
      inputSchema: z.object({
        fields: z.array(z.object({
          ref: z.number().describe('Element ref number'),
          value: z.string().describe('Value to fill'),
        })).describe('Fields to fill'),
        submit: z.boolean().optional().describe('Submit the form after filling'),
      }),
    },
    async ({ fields, submit }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('fill_form', { fields, submit })) as { filled: number };
        return text(`Filled ${data.filled} field${data.filled === 1 ? '' : 's'}.`);
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'select',
    {
      description: 'Select option(s) in a dropdown element by ref.',
      inputSchema: z.object({
        ref: z.number().describe('Element ref number'),
        value: z.union([z.string(), z.array(z.string())]).describe('Option value(s) to select'),
      }),
    },
    async ({ ref, value }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        await bridge.sendCommand('select', { ref, value });
        return text('Selected successfully.');
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'hover',
    {
      description: 'Hover over an element to trigger tooltips or dropdown menus.',
      inputSchema: z.object({
        ref: z.number().describe('Element ref number'),
      }),
    },
    async ({ ref }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        await bridge.sendCommand('hover', { ref });
        return text('Hovered successfully.');
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'scroll',
    {
      description: 'Scroll the page or a specific element. Returns updated page snapshot.',
      inputSchema: z.object({
        direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
        amount: z.union([z.literal('page'), z.literal('half'), z.number()]).optional().describe('Scroll amount: "page", "half", or pixels'),
        ref: z.number().optional().describe('Element ref to scroll (scrolls page if omitted)'),
      }),
    },
    async ({ direction, amount, ref }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('scroll', { direction, amount, ref })) as PageSnapshot;
        return text(serializeSnapshot(data));
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'press_key',
    {
      description: 'Press a keyboard key, optionally with modifiers (Ctrl, Shift, Alt, Meta). Examples: "Enter", "Tab", "Escape", "a".',
      inputSchema: z.object({
        key: z.string().describe('Key name (e.g. "Enter", "Tab", "a", "ArrowDown")'),
        modifiers: z.array(z.string()).optional().describe('Modifier keys: "Ctrl", "Shift", "Alt", "Meta"'),
      }),
    },
    async ({ key, modifiers }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        await bridge.sendCommand('press_key', { key, modifiers });
        return text(`Pressed ${modifiers?.length ? modifiers.join('+') + '+' : ''}${key}.`);
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'drag',
    {
      description: 'Drag an element from one position to another.',
      inputSchema: z.object({
        fromRef: z.number().describe('Ref of element to drag'),
        toRef: z.number().describe('Ref of target element to drop onto'),
      }),
    },
    async ({ fromRef, toRef }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        await bridge.sendCommand('drag', { fromRef, toRef });
        return text('Drag completed.');
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'upload',
    {
      description: 'Upload a file to a file input element.',
      inputSchema: z.object({
        ref: z.number().describe('Ref of file input element'),
        filePath: z.string().describe('Absolute path to the file to upload'),
      }),
    },
    async ({ ref, filePath }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        await bridge.sendCommand('upload', { ref, filePath });
        return text('File uploaded.');
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'click_by_text',
    {
      description: 'Click an element by its visible text content. No prior snapshot needed — finds and clicks in one call. Returns updated snapshot.',
      inputSchema: z.object({
        text: z.string().describe('Text to search for (case-insensitive)'),
        role: z.string().optional().describe('Filter by element role (button, link, etc)'),
        index: z.number().optional().describe('Which match to click if multiple (0 = first, default)'),
      }),
    },
    async ({ text: searchText, role, index }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('click_by_text', { text: searchText, role, index })) as PageSnapshot;
        return text(serializeSnapshot(data));
      } catch (err) {
        return error(err);
      }
    },
  );

  server.registerTool(
    'dismiss_modal',
    {
      description: 'Dismiss a modal, dialog, or popup overlay. Automatically finds common dismiss buttons (Close, No thanks, Skip, ×). Provide text to target a specific dismiss button.',
      inputSchema: z.object({
        text: z.string().optional().describe('Text of the dismiss button to click (e.g., "No thanks")'),
      }),
    },
    async ({ text: dismissText }) => {
      if (!bridge.isConnected()) return notConnected();
      try {
        const data = (await bridge.sendCommand('dismiss_modal', { text: dismissText })) as PageSnapshot;
        return text(serializeSnapshot(data));
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
