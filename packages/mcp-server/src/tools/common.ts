/**
 * Parameters and behaviour several tools share: acting on a named tab, and waiting for the page after an action.
 */
import { z } from 'zod';
import type { ActionResult, PageSnapshot } from '@onbridge/shared';
import { errorRetry, isTrustedError } from '../bridge.js';
import type { Bridge } from '../bridge.js';

/**
 * Every page tool takes this. The command envelope has carried a tab id since the first release and the extension has always resolved and scope-checked it, so this costs nothing on either side; it was simply never offered to the agent, which left comparing four shops as a `switch_tab` before every call.
 */
export const tabIdParam = z
  .number()
  .optional()
  .describe(
    'Act on this tab (an id from list_tabs) instead of the current one, so several tabs can be worked without switch_tab. ' +
      'The tab must be inside the control the user granted. Refs belong to the tab they came from.',
  );

export const DEFAULT_WAIT_MS = 10_000;

export const waitSpecSchema = z.object({
  text: z.string().optional().describe('Wait for this text to appear on the page'),
  textGone: z.string().optional().describe('Wait for this text to disappear from the page'),
  selector: z.string().optional().describe('Wait for an element matching this CSS selector'),
  timeout: z.number().optional().describe(`Max wait in milliseconds (default ${DEFAULT_WAIT_MS})`),
});
export type WaitSpec = z.infer<typeof waitSpecSchema>;

export const waitForParam = waitSpecSchema
  .optional()
  .describe(
    'After the action, wait for this before capturing the page: text to appear, text to disappear, or a selector to match. ' +
      'An empty object waits for the page to finish loading and settle. If the condition is not met in time the reply says so; ' +
      'the action itself still happened.',
  );

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The content script answers a command within 25s, so a longer wait is made of several shorter ones. */
const WAIT_CHUNK_MS = 20_000;

function hasCondition(spec: WaitSpec): boolean {
  return Boolean(spec.text || spec.textGone || spec.selector);
}

/**
 * Waits for a condition on the page, or with no condition for the page to load and settle.
 *
 * Resolves with whether the condition was met; a timeout is an answer, not an exception. Throws only for a failure that is not a timeout, such as an invalid selector. A page caught between documents is waited out rather than failed, since "still loading" is the very thing being waited for.
 *
 * A current extension reports its own timeout with the `wait-timeout` code. An older one reports it as a plain error with no code, which cannot be told from a page failure by wording, so it is read from time instead: an error that arrives once the budget is spent is the timeout.
 */
export async function performWait(
  bridge: Bridge,
  spec: WaitSpec,
  tabId?: number,
): Promise<{ met: boolean; elapsed: number }> {
  const budget = Math.max(0, spec.timeout ?? DEFAULT_WAIT_MS);
  const start = Date.now();
  const elapsed = () => Date.now() - start;

  if (!hasCondition(spec)) return waitForLoad(bridge, budget, tabId);

  for (;;) {
    const remaining = budget - elapsed();
    if (remaining <= 0) return { met: false, elapsed: elapsed() };
    const chunk = Math.min(remaining, WAIT_CHUNK_MS);
    const sentAt = Date.now();
    try {
      await bridge.sendCommand(
        'wait',
        { text: spec.text, textGone: spec.textGone, selector: spec.selector, timeout: chunk },
        tabId,
        chunk + 5_000,
      );
      return { met: true, elapsed: elapsed() };
    } catch (err) {
      const retry = errorRetry(err);
      if (retry?.code === 'wait-timeout') {
        if (elapsed() >= budget) return { met: false, elapsed: elapsed() };
        continue;
      }
      if (retry?.code === 'navigating') {
        await sleep(Math.min(retry.retryAfterMs ?? 500, remaining));
        continue;
      }
      // An older extension's timeout: a plain error that took the whole chunk to arrive.
      if (!isTrustedError(err) && Date.now() - sentAt >= chunk - 250) {
        if (elapsed() >= budget) return { met: false, elapsed: elapsed() };
        continue;
      }
      throw err;
    }
  }
}

/**
 * Waits for the page to finish loading and its DOM to go quiet.
 *
 * A current extension does this itself (`wait-load`): it watches the tab's load state and then the DOM. An older one is approximated by polling how much text the page has until that stops changing, which is the same signal taken from outside. Never throws on timeout: "it was still changing" is the answer.
 */
async function waitForLoad(bridge: Bridge, budget: number, tabId?: number): Promise<{ met: boolean; elapsed: number }> {
  const start = Date.now();
  const elapsed = () => Date.now() - start;

  if (bridge.hasFeature('wait-load')) {
    const data = (await bridge.sendCommand('wait', { timeout: budget }, tabId, budget + 5_000)) as {
      loaded?: boolean;
    } | null;
    return { met: data?.loaded !== false, elapsed: elapsed() };
  }

  let previous = -1;
  let stable = 0;
  while (elapsed() < budget) {
    try {
      const data = (await bridge.sendCommand('extract_text', { maxChars: 1 }, tabId)) as { chars?: number } | null;
      const chars = Number(data?.chars) || 0;
      if (chars > 0 && chars === previous) {
        if (++stable >= 2) return { met: true, elapsed: elapsed() };
      } else {
        stable = 0;
      }
      previous = chars;
    } catch (err) {
      if (errorRetry(err)?.code !== 'navigating') throw err;
    }
    await sleep(Math.min(500, Math.max(0, budget - elapsed())));
  }
  return { met: false, elapsed: elapsed() };
}

/**
 * Honours a `waitFor` after an action that already happened: waits, then captures the page again so the reply shows it as it is after the wait. Returns the note for the reply. Never throws, because the action is done and must be reported as done whatever the wait did.
 */
export async function applyWaitFor(
  bridge: Bridge,
  result: ActionResult,
  waitFor: WaitSpec | undefined,
  /** How to capture the page afterwards, or null to leave the result without a capture (the agent asked for none). */
  snapshotParams: { compact?: boolean; depth?: number } | null,
  tabId?: number,
): Promise<string | undefined> {
  if (!waitFor) return undefined;
  let note: string;
  try {
    const { met, elapsed } = await performWait(bridge, waitFor, tabId);
    note = met
      ? `Waited ${elapsed}ms for the waitFor condition.`
      : `The waitFor condition was not met within ${waitFor.timeout ?? DEFAULT_WAIT_MS}ms; the page below is as it stood after that wait.`;
  } catch {
    note = 'The waitFor condition could not be checked (an invalid selector, or the page could not be reached); the action itself happened.';
  }
  if (!snapshotParams) return note;
  try {
    const snap = (await bridge.sendCommand('snapshot', snapshotParams, tabId)) as PageSnapshot;
    result.snapshot = snap;
    result.snapshotError = undefined;
    if (snap?.url) result.url = snap.url;
    if (snap?.title) result.title = snap.title;
  } catch {
    result.snapshot = undefined;
    result.snapshotError = 'the page could not be captured after the wait';
  }
  return note;
}
