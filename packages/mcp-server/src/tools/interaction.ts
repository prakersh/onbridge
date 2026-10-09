import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ActionResult } from '@onbridge/shared';
import type { Bridge } from '../bridge.js';
import { errorRetry, isTrustedError } from '../bridge.js';
import { text, pageText, error, notConnected, actionReply } from './reply.js';
import { tabIdParam, waitForParam, applyWaitFor } from './common.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long `click_by_text` keeps looking for its text before giving up, unless told otherwise. */
const CLICK_BY_TEXT_WAIT_MS = 5_000;

/** What `type` reports back. `value` and `fallback` come from a current extension; an older one sends neither. */
interface TypeResult extends Partial<ActionResult> {
  success?: boolean;
  trusted?: boolean;
  /** The field's content after typing, as the page holds it. Masked for password fields. */
  value?: string;
  /** The real keystrokes left the field empty, so the value was set directly instead. */
  fallback?: boolean;
}

export function registerInteractionTools(server: McpServer, bridge: Bridge): void {
  server.registerTool(
    'click',
    {
      description:
        'Click an element by ref number (from snapshot/find). Reports whether the page navigated, where it ended up, ' +
        'and the updated snapshot (on the same page, only what changed since the last whole page). If the click ran but the page could not be captured afterwards the call still succeeds ' +
        'and says so — it never reports a click that happened as a failure, so do not re-click on an error. ' +
        'A [stale-ref] error means the ref no longer names anything: take a fresh snapshot. ' +
        'Pass waitFor when the click starts something that takes a moment (a results list, a dialog): the page is captured once the condition holds.',
      inputSchema: z.object({
        ref: z.number().describe('Element ref number from snapshot or find'),
        button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button'),
        doubleClick: z.boolean().optional().describe('Double-click instead of single'),
        waitFor: waitForParam,
        tabId: tabIdParam,
      }),
    },
    async ({ ref, button, doubleClick, waitFor, tabId }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('click', { ref, button, doubleClick }, tabId)) as ActionResult;
        const note = await applyWaitFor(bridge, data, waitFor, {}, tabId);
        return actionReply(bridge, data, `Clicked.${note ? ` ${note}` : ''}`);
      } catch (err) {
        return error(err, bridge);
      }
    },
  );

  server.registerTool(
    'type',
    {
      description:
        'Type text into an input element by ref, as real keystrokes: the field is clicked to focus it and the text is inserted the way a keyboard would, which is what React, Vue and autocomplete fields expect. ' +
        'Set clear to erase existing text first. Set submit to press Enter after typing. Reports whether submitting navigated the page, and what the field holds afterwards. ' +
        'If the field reads empty after typing, the page rejected or reset the input: use fill_form for that field, which sets the value directly and fires input/change events instead.',
      inputSchema: z.object({
        ref: z.number().describe('Element ref number'),
        text: z.string().describe('Text to type'),
        clear: z.boolean().optional().describe('Clear existing text first'),
        submit: z.boolean().optional().describe('Press Enter after typing'),
        tabId: tabIdParam,
      }),
    },
    async ({ ref, text: inputText, clear, submit, tabId }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('type', { ref, text: inputText, clear, submit }, tabId)) as
          | TypeResult
          | undefined;
        // Enter in a search box is a navigation with no destination anywhere in
        // the parameters. Reporting a bare "Typed successfully" while the
        // browser was already on a different page left the agent acting on a
        // page it did not know it had left.
        if (data?.navigated) {
          return actionReply(
            bridge,
            { ...(data as ActionResult), ok: true, action: 'type' },
            'Typed.',
          );
        }
        // What the field holds now is the only evidence the typing took. An older extension does not report it, and then the old wording stands.
        if (typeof data?.value !== 'string') return text(bridge, 'Typed successfully.');
        if (data.value === '' && inputText) {
          return text(
            bridge,
            'Typed, but the field reads empty afterwards: the page rejected or reset the input' +
              (data.fallback ? ', even when the value was set directly' : '') +
              '. Check the ref still names the right field (take a fresh snapshot), and try fill_form for it, which sets the value directly.',
          );
        }
        return pageText(
          bridge,
          data.value,
          data.fallback
            ? 'Typed. The keystrokes left the field empty, so its value was set directly instead; it now reads:'
            : 'Typed. The field now reads:',
        );
      } catch (err) {
        return error(err, bridge);
      }
    },
  );

  server.registerTool(
    'fill_form',
    {
      description:
        'Fill multiple form fields at once. Each field identified by ref number and value. Major token saver vs ' +
        'individual type calls. Sets each value directly and fires input and change events, rather than typing keystrokes: ' +
        'use type instead for a field that reacts to keys (autocomplete, masked input). Reports whether submitting navigated the page, and any refs it could not find.',
      inputSchema: z.object({
        fields: z.array(z.object({
          ref: z.number().describe('Element ref number'),
          value: z.string().describe('Value to fill'),
        })).describe('Fields to fill'),
        submit: z.boolean().optional().describe('Submit the form after filling'),
        tabId: tabIdParam,
      }),
    },
    async ({ fields, submit, tabId }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('fill_form', { fields, submit }, tabId)) as {
          filled: number;
          /** Refs that named nothing on the page. Reported by a current extension; an older one skips them silently. */
          missing?: number[];
        } & Partial<ActionResult>;
        let filled = `Filled ${data.filled} field${data.filled === 1 ? '' : 's'}.`;
        if (Array.isArray(data.missing) && data.missing.length) {
          filled +=
            ` Ref${data.missing.length === 1 ? '' : 's'} ${data.missing.join(', ')} named nothing on the page, so ` +
            `${data.missing.length === 1 ? 'that field was' : 'those fields were'} not filled: take a fresh snapshot and use the new refs.`;
        }
        // Submitting a login form navigates, and the agent had no way to learn
        // that from "Filled 2 fields."
        if (data.navigated) {
          return actionReply(bridge, { ...(data as ActionResult), ok: true, action: 'fill_form' }, filled);
        }
        return text(bridge, filled);
      } catch (err) {
        return error(err, bridge);
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
        tabId: tabIdParam,
      }),
    },
    async ({ ref, value, tabId }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        await bridge.sendCommand('select', { ref, value }, tabId);
        return text(bridge, 'Selected successfully.');
      } catch (err) {
        return error(err, bridge);
      }
    },
  );

  server.registerTool(
    'hover',
    {
      description: 'Hover over an element to trigger tooltips or dropdown menus.',
      inputSchema: z.object({
        ref: z.number().describe('Element ref number'),
        tabId: tabIdParam,
      }),
    },
    async ({ ref, tabId }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        await bridge.sendCommand('hover', { ref }, tabId);
        return text(bridge, 'Hovered successfully.');
      } catch (err) {
        return error(err, bridge);
      }
    },
  );

  server.registerTool(
    'scroll',
    {
      description: 'Scroll the page or a specific element. Returns where the page is now and an updated snapshot (only what changed since the last whole page, when that is smaller).',
      inputSchema: z.object({
        direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
        amount: z.union([z.literal('page'), z.literal('half'), z.number()]).optional().describe('Scroll amount: "page", "half", or pixels'),
        ref: z.number().optional().describe('Element ref to scroll (scrolls page if omitted)'),
        tabId: tabIdParam,
      }),
    },
    async ({ direction, amount, ref, tabId }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('scroll', { direction, amount, ref }, tabId)) as ActionResult;
        return actionReply(bridge, data, 'Scrolled.');
      } catch (err) {
        return error(err, bridge);
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
        tabId: tabIdParam,
      }),
    },
    async ({ key, modifiers, tabId }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('press_key', { key, modifiers }, tabId)) as
          | Partial<ActionResult>
          | undefined;
        const pressed = `Pressed ${modifiers?.length ? modifiers.join('+') + '+' : ''}${key}.`;
        if (data?.navigated) {
          return actionReply(bridge, { ...(data as ActionResult), ok: true, action: 'press_key' }, pressed);
        }
        return text(bridge, pressed);
      } catch (err) {
        return error(err, bridge);
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
        tabId: tabIdParam,
      }),
    },
    async ({ fromRef, toRef, tabId }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        await bridge.sendCommand('drag', { fromRef, toRef }, tabId);
        return text(bridge, 'Drag completed.');
      } catch (err) {
        return error(err, bridge);
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
        tabId: tabIdParam,
      }),
    },
    async ({ ref, filePath, tabId }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        await bridge.sendCommand('upload', { ref, filePath }, tabId);
        return text(bridge, 'File uploaded.');
      } catch (err) {
        return error(err, bridge);
      }
    },
  );

  server.registerTool(
    'click_by_text',
    {
      description:
        'Click an element by its visible text content. No prior snapshot needed — finds and clicks in one call. ' +
        'Keeps looking for the text for up to timeoutMs (default 5000) before giving up, so a page that is still filling in does not need a separate wait. ' +
        'Reports whether the page navigated, where it ended up, and the updated snapshot (on the same page, only what changed since the last whole page). ' +
        'Pass waitFor to capture the page only once something the click starts has appeared.',
      inputSchema: z.object({
        text: z.string().describe('Text to search for (case-insensitive)'),
        role: z.string().optional().describe('Filter by element role (button, link, etc)'),
        index: z.number().optional().describe('Which match to click if multiple (0 = first, default)'),
        timeoutMs: z
          .number()
          .optional()
          .describe(`How long to keep looking for the text before failing (default ${CLICK_BY_TEXT_WAIT_MS}). 0 tries once.`),
        waitFor: waitForParam,
        tabId: tabIdParam,
      }),
    },
    async ({ text: searchText, role, index, timeoutMs, waitFor, tabId }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = await clickByTextPatiently(bridge, { text: searchText, role, index }, timeoutMs ?? CLICK_BY_TEXT_WAIT_MS, tabId);
        const note = await applyWaitFor(bridge, data, waitFor, {}, tabId);
        return actionReply(bridge, data, `Clicked.${note ? ` ${note}` : ''}`);
      } catch (err) {
        return error(err, bridge);
      }
    },
  );

  server.registerTool(
    'dismiss_modal',
    {
      description: 'Dismiss a modal, dialog, or popup overlay. Automatically finds common dismiss buttons (Close, No thanks, Skip, ×). Provide text to target a specific dismiss button.',
      inputSchema: z.object({
        text: z.string().optional().describe('Text of the dismiss button to click (e.g., "No thanks")'),
        tabId: tabIdParam,
      }),
    },
    async ({ text: dismissText, tabId }) => {
      if (!bridge.isConnected()) return notConnected(bridge);
      try {
        const data = (await bridge.sendCommand('dismiss_modal', { text: dismissText }, tabId)) as ActionResult;
        return actionReply(bridge, data, 'Dismissed.');
      } catch (err) {
        return error(err, bridge);
      }
    },
  );
}

/**
 * Keeps trying `click_by_text` while the page is not ready for it.
 *
 * The text an agent wants to click is very often the thing a page is still fetching ("Hang on, loading content"), and a single attempt turned every such page into a failure, a wait and a retry. A failure here is never a click that happened: the extension reports a landed click as success whatever happens afterwards, so what fails is finding the text, locating it, or a page between documents. A refusal onbridge composed (policy, scope) is final and is not retried; a page-side failure, or the typed "navigating" condition, is tried again until the budget runs out.
 */
async function clickByTextPatiently(
  bridge: Bridge,
  params: { text: string; role?: string; index?: number },
  budgetMs: number,
  tabId?: number,
): Promise<ActionResult> {
  const start = Date.now();
  for (;;) {
    try {
      return (await bridge.sendCommand('click_by_text', params, tabId)) as ActionResult;
    } catch (err) {
      const retry = errorRetry(err);
      const transient = retry?.code === 'navigating' || !isTrustedError(err);
      if (!transient || Date.now() - start >= budgetMs) throw err;
      await sleep(Math.min(500, retry?.retryAfterMs ?? 500));
    }
  }
}
