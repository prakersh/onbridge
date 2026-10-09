/**
 * The fixes for what an agent reported after a day of shopping rounds: a `find` crash, refs that silently moved, no way to wait for a page, fields read one call at a time, every tool bound to the current tab, and disconnects that all looked alike.
 *
 * Each runs through the real server over stdio and the encrypted channel, against a simulated extension: first a current one, which announces its features, then an older one, which does not and is covered by the server's fallbacks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ALL_COMMAND_ACTIONS } from '@onbridge/shared';
import { notConnectedText } from '../src/bridge.js';
import {
  startServer,
  openSession,
  waitForBridge,
  waitForListening,
  type Harness,
  type Session,
} from './session-helper.js';

let h: Harness;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (res: any): string => (res.result?.content ?? []).map((c: any) => c.text ?? '').join('\n');
const call = (name: string, args: Record<string, unknown> = {}) => h.rpc('tools/call', { name, arguments: args });

const page = (url: string, title: string, refs: number[] = []) => ({
  url,
  title,
  tree: refs.map((ref) => ({ role: 'button', ref, name: `Button ${ref}` })),
  scroll: { percent: 0, pagesAbove: 0, pagesBelow: 0 },
  refCount: refs.length,
});
const acted = (url: string, title: string, refs: number[] = []) => ({
  ok: true,
  action: 'click',
  navigated: false,
  url,
  title,
  snapshot: page(url, title, refs),
});
const trusted = (message: string, code?: string) =>
  Object.assign(new Error(message), { onbridgeTrusted: true, ...(code ? { onbridgeCode: code } : {}) });

beforeAll(async () => {
  h = startServer();
  await h.rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1' },
  });
  await waitForListening();
}, 30_000);

afterAll(() => h?.stop());

describe('with a current extension', () => {
  let session: Session;

  beforeAll(async () => {
    session = await openSession({ installId: 'a'.repeat(32) });
    session.onCommand(() => ({ accessScope: 'all', paused: false, commandCount: 0 }));
    await waitForBridge(h);
  });

  afterAll(async () => {
    await session?.close();
  });

  it('passes a tabId through to the browser, so another tab can be read without switching', async () => {
    let seen: number | undefined;
    session.onCommand((action, _params, tabId) => {
      if (action === 'find') seen = tabId;
      return [];
    });
    await call('find', { text: 'price', tabId: 42 });
    expect(seen).toBe(42);
  });

  it('click with waitFor captures the page after the condition holds', async () => {
    const seen: string[] = [];
    session.onCommand((action, params) => {
      seen.push(action);
      if (action === 'click') return acted('https://shop.test/w1', 'Before');
      if (action === 'wait') {
        expect(params.text).toBe('Results');
        return { success: true, elapsed: 5 };
      }
      if (action === 'snapshot') return page('https://shop.test/w1', 'After');
      throw new Error(`unexpected ${action}`);
    });
    const out = textOf(await call('click', { ref: 1, waitFor: { text: 'Results' } }));
    expect(seen).toEqual(['click', 'wait', 'snapshot']);
    expect(out).toMatch(/Waited \d+ms for the waitFor condition/);
    expect(out).toContain('[title] After');
    expect(out).not.toContain('Before');
  });

  it('navigate with waitFor skips the arrival capture and takes one after the wait', async () => {
    const seen: string[] = [];
    session.onCommand((action, params) => {
      seen.push(action);
      if (action === 'navigate') {
        expect(params.snapshot).toBe(false);
        return { ok: true, action: 'navigate', navigated: true, url: 'https://shop.test/w2', title: 'Loading' };
      }
      if (action === 'wait') return { success: true, elapsed: 5 };
      if (action === 'snapshot') return page('https://shop.test/w2', 'Loaded');
      throw new Error(`unexpected ${action}`);
    });
    const out = textOf(await call('navigate', { url: 'https://shop.test/w2', waitFor: { textGone: 'Hang on' } }));
    expect(seen).toEqual(['navigate', 'wait', 'snapshot']);
    expect(out).toContain('[title] Loaded');
  });

  it('a waitFor that is not met still reports the action as done', async () => {
    session.onCommand((action) => {
      if (action === 'click') return acted('https://shop.test/w3', 'Page');
      if (action === 'wait') throw trusted('Wait timed out after 200ms', 'wait-timeout');
      if (action === 'snapshot') return page('https://shop.test/w3', 'Page');
      throw new Error(`unexpected ${action}`);
    });
    const res = await call('click', { ref: 1, waitFor: { text: 'Never', timeout: 200 } });
    expect(res.result.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/Clicked\./);
    expect(textOf(res)).toMatch(/waitFor condition was not met within 200ms/);
  });

  it('click_by_text keeps looking while the page fills in', async () => {
    let attempts = 0;
    session.onCommand((action) => {
      if (action !== 'click_by_text') throw new Error(`unexpected ${action}`);
      attempts++;
      if (attempts < 3) throw new Error('No element found with text "Add to cart"');
      return acted('https://shop.test/c1', 'Cart');
    });
    const out = textOf(await call('click_by_text', { text: 'Add to cart' }));
    expect(attempts).toBe(3);
    expect(out).toMatch(/^Clicked\./);
  });

  it('click_by_text does not retry a refusal, and tries once with timeoutMs 0', async () => {
    let attempts = 0;
    session.onCommand(() => {
      attempts++;
      throw trusted('Blocked by user policy: shop.test is on the blocked list for this browser.');
    });
    const res = await call('click_by_text', { text: 'Buy now' });
    expect(res.result.isError).toBe(true);
    expect(attempts).toBe(1);

    attempts = 0;
    session.onCommand(() => {
      attempts++;
      throw new Error('No element found with text "Buy now"');
    });
    const once = await call('click_by_text', { text: 'Buy now', timeoutMs: 0 });
    expect(once.result.isError).toBe(true);
    expect(attempts).toBe(1);
  });

  it('wait with no condition asks the extension to wait for the page to load', async () => {
    session.onCommand((action, params) => {
      expect(action).toBe('wait');
      expect(params.text ?? params.textGone ?? params.selector).toBeUndefined();
      return { success: true, elapsed: 12, loaded: true };
    });
    expect(textOf(await call('wait', {}))).toMatch(/finished loading and settled after \d+ms/);

    session.onCommand(() => ({ success: true, elapsed: 3000, loaded: false }));
    const res = await call('wait', { timeout: 3000 });
    expect(res.result.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/still changing/);
  });

  it('a conditional wait that runs out is a typed timeout, not a page error', async () => {
    session.onCommand(() => {
      throw trusted('Wait timed out after 300ms', 'wait-timeout');
    });
    const res = await call('wait', { text: 'Never', timeout: 300 });
    expect(res.result.isError).toBe(true);
    expect(textOf(res)).toContain('[wait-timeout]');
    expect(textOf(res)).not.toMatch(/<untrusted-page-content/);
  });

  it('dom_query returns several fields per match in one call', async () => {
    session.onCommand((action, params) => {
      expect(action).toBe('dom_query');
      expect(params.fields).toEqual({ id: '@data-asin', title: 'h2', price: '.price' });
      expect(params.limit).toBe(50);
      return {
        matches: 2,
        results: [
          { index: 0, tag: 'div', text: 'Phone X', fields: { id: 'B0A', title: 'Phone X', price: '₹12,999' } },
          { index: 1, tag: 'div', text: 'Phone Y', fields: { id: 'B0B', title: 'Phone Y', price: null } },
        ],
      };
    });
    const out = textOf(
      await call('dom_query', { selector: '[data-asin]', fields: { id: '@data-asin', title: 'h2', price: '.price' }, limit: 50 }),
    );
    expect(out).toContain('id: B0A');
    expect(out).toContain('price: ₹12,999');
    expect(out).toContain('price: (none)');
    expect(out).not.toMatch(/newer extension/);
  });

  it('type reports what the field holds afterwards', async () => {
    session.onCommand(() => ({ success: true, trusted: true, value: '400001' }));
    const out = textOf(await call('type', { ref: 1, text: '400001' }));
    expect(out).toMatch(/The field now reads:/);
    expect(out).toContain('400001');

    session.onCommand(() => ({ success: true, trusted: true, value: '' }));
    const empty = textOf(await call('type', { ref: 1, text: '400001' }));
    expect(empty).toMatch(/reads empty afterwards/);
    expect(empty).toMatch(/fill_form/);

    session.onCommand(() => ({ success: true, trusted: false, value: '400001', fallback: true }));
    expect(textOf(await call('type', { ref: 1, text: '400001' }))).toMatch(/set directly instead/);
  });

  it('type from an extension that reports no value keeps the old wording', async () => {
    session.onCommand(() => ({ success: true, trusted: true }));
    expect(textOf(await call('type', { ref: 1, text: 'x' }))).toContain('Typed successfully.');
  });

  it('fill_form says which refs it could not find', async () => {
    session.onCommand(() => ({ filled: 1, missing: [9] }));
    const out = textOf(await call('fill_form', { fields: [{ ref: 1, value: 'a' }, { ref: 9, value: 'b' }] }));
    expect(out).toContain('Filled 1 field.');
    expect(out).toMatch(/Ref 9 named nothing/);
  });

  it('a stale ref from the extension is an explicit, authoritative error', async () => {
    let sent = 0;
    session.onCommand(() => {
      sent++;
      throw trusted('Ref 3 is not on tab 1 any more: the tab has loaded a new document since it was issued.', 'ref-not-found');
    });
    const res = await call('click', { ref: 3 });
    expect(sent).toBe(1);
    expect(res.result.isError).toBe(true);
    expect(textOf(res)).toContain('[stale-ref]');
    expect(textOf(res)).toMatch(/fresh snapshot or find/);
    expect(textOf(res)).not.toMatch(/making it again is safe/);
  });

  it('blanks out what the user asked the panel to hide', async () => {
    session.onCommand(() => ({ text: 'Call 98765 43210 or write to ravi@example.com for the order' }));
    await session.emit({ type: 'preferences', redact: ['phone', 'email', 'bogus'] });
    await sleep(100);
    const hidden = textOf(await call('get_text', { ref: 1 }));
    expect(hidden).toContain('[phone number redacted]');
    expect(hidden).toContain('[email redacted]');
    expect(hidden).not.toContain('98765');

    await session.emit({ type: 'preferences', redact: [] });
    await sleep(100);
    expect(textOf(await call('get_text', { ref: 1 }))).toContain('98765 43210');
  });

  it('bridge_status reports stable refs', async () => {
    session.onCommand(() => ({ approvalMode: 'auto', scopeKind: 'all', accessScope: 'the whole browser' }));
    expect(textOf(await call('bridge_status'))).toMatch(/Refs: stable across snapshots/);
  });
});

describe('with an older extension', () => {
  let session: Session;
  let sent: string[] = [];

  beforeAll(async () => {
    session = await openSession({ installId: 'b'.repeat(32), announce: false });
    session.onCommand(() => ({ accessScope: 'all', paused: false, commandCount: 0 }));
    // Lists its actions, as the extension in the store does, but knows nothing of features.
    await session.emit({ type: 'ready', version: '0.5.2', controlMode: true, actions: [...ALL_COMMAND_ACTIONS] });
    await waitForBridge(h);
  });

  afterAll(async () => {
    await session?.close();
  });

  it('find by text alone is retried without the elements that crash it', async () => {
    const calls: any[] = [];
    session.onCommand((action, params) => {
      calls.push(params);
      if (!params.selector) throw new TypeError('(intermediate value).toLowerCase is not a function');
      return [{ ref: 4, role: 'button', name: 'Buy', context: 'in form' }];
    });
    const out = textOf(await call('find', { text: 'buy' }));
    expect(calls).toHaveLength(2);
    expect(calls[1].selector).toBe('*:not(li):not(meter):not(progress)');
    expect(out).toContain('"Buy"');
    expect(out).toMatch(/cannot search list items/);
    expect(out).toContain('v0.5.2');
  });

  it('find with a role or selector is not second-guessed', async () => {
    let calls = 0;
    session.onCommand(() => {
      calls++;
      throw new TypeError('(intermediate value).toLowerCase is not a function');
    });
    const res = await call('find', { text: 'buy', role: 'listitem' });
    expect(calls).toBe(1);
    expect(res.result.isError).toBe(true);
  });

  it('refuses a ref issued before the latest capture, on the extension\'s behalf', async () => {
    sent = [];
    session.onCommand((action) => {
      sent.push(action);
      if (action === 'snapshot') return page('https://shop.test/s1', 'Shop', [7]);
      if (action === 'click') return acted('https://shop.test/s1', 'Shop', [7]);
      throw new Error(`unexpected ${action}`);
    });

    // Never issued: refused without a round trip.
    const unknown = await call('click', { ref: 5 });
    expect(unknown.result.isError).toBe(true);
    expect(textOf(unknown)).toContain('[stale-ref]');
    expect(textOf(unknown)).toMatch(/renumbers refs/);
    expect(textOf(unknown)).toContain('v0.5.2');
    expect(sent).toEqual([]);

    // Issued by the latest capture: sent.
    await call('snapshot');
    expect(textOf(await call('click', { ref: 7 }))).toMatch(/^Clicked\./);
    expect(sent).toEqual(['snapshot', 'click']);

    // The click's own capture re-issued 7, so it is still good.
    expect((await call('click', { ref: 7 })).result.isError).toBeFalsy();

    // A later capture without it makes it stale.
    session.onCommand((action) => {
      sent.push(action);
      if (action === 'snapshot') return page('https://shop.test/s1', 'Shop', [9]);
      return acted('https://shop.test/s1', 'Shop', [9]);
    });
    await call('snapshot');
    const before = sent.length;
    const stale = await call('click', { ref: 7 });
    expect(stale.result.isError).toBe(true);
    expect(textOf(stale)).toContain('[stale-ref]');
    expect(sent.length).toBe(before);
    expect((await call('click', { ref: 9 })).result.isError).toBeFalsy();
  });

  it('refs in fill_form fields and a snapshot target are checked too', async () => {
    const res = await call('fill_form', { fields: [{ ref: 9, value: 'a' }, { ref: 77, value: 'b' }] });
    expect(res.result.isError).toBe(true);
    expect(textOf(res)).toMatch(/Ref 77 was/);
    expect((await call('snapshot', { target: 77 })).result.isError).toBe(true);
  });

  it('wait with no condition is approximated by polling the page', async () => {
    const seen: string[] = [];
    session.onCommand((action, params) => {
      seen.push(action);
      if (action === 'extract_text') {
        expect(params.maxChars).toBe(1);
        return { text: 'x', chars: 2048, truncated: true };
      }
      throw new Error(`unexpected ${action}`);
    });
    const out = textOf(await call('wait', { timeout: 5000 }));
    expect(out).toMatch(/finished loading and settled/);
    expect(seen).not.toContain('wait');
    expect(seen.filter((a) => a === 'extract_text').length).toBeGreaterThanOrEqual(3);
  });

  it('a conditional wait that runs out is read as a timeout from the time it took', async () => {
    session.onCommand(async (action, params) => {
      expect(action).toBe('wait');
      await sleep(params.timeout);
      throw new Error(`Wait timed out after ${params.timeout}ms`);
    });
    const res = await call('wait', { text: 'Never', timeout: 400 });
    expect(res.result.isError).toBe(true);
    expect(textOf(res)).toContain('[wait-timeout]');
  });

  it('a conditional wait that fails at once is an error, not a timeout', async () => {
    session.onCommand(() => {
      throw new Error("Failed to execute 'querySelector': '[[' is not a valid selector.");
    });
    const res = await call('wait', { selector: '[[', timeout: 2000 });
    expect(res.result.isError).toBe(true);
    expect(textOf(res)).not.toContain('[wait-timeout]');
  });

  it('dom_query fields are filled in from attributes where possible, and said to need an update otherwise', async () => {
    const seen: any[] = [];
    session.onCommand((action, params) => {
      seen.push(params);
      if (params.action === 'attr') {
        return {
          matches: 2,
          attr: params.attr,
          values: [
            { index: 0, tag: 'div', value: 'B0A', text: '' },
            { index: 1, tag: 'div', value: 'B0B', text: '' },
          ],
        };
      }
      return {
        matches: 2,
        results: [
          { index: 0, tag: 'div', text: 'Phone X' },
          { index: 1, tag: 'div', text: 'Phone Y' },
        ],
      };
    });
    const out = textOf(await call('dom_query', { selector: '[data-asin]', fields: { id: '@data-asin', title: 'h2' } }));
    expect(seen.map((p) => p.action ?? 'list')).toEqual(['list', 'attr']);
    expect(seen[1].attr).toBe('data-asin');
    expect(out).toContain('id: B0A');
    expect(out).toContain('id: B0B');
    expect(out).toContain('title: (needs a newer extension)');
    expect(out).toMatch(/does not read fields/);
  });

  it('bridge_status says refs are renumbered', async () => {
    session.onCommand(() => ({ approvalMode: 'auto', scopeKind: 'all', accessScope: 'the whole browser' }));
    expect(textOf(await call('bridge_status'))).toMatch(/Refs: renumbered/);
  });
});

describe('when the browser goes away', () => {
  const install = 'c'.repeat(32);

  it('says a command in flight may have run', async () => {
    const session = await openSession({ installId: install });
    session.onCommand(() => ({ accessScope: 'all', paused: false, commandCount: 0 }));
    await waitForBridge(h);
    session.onCommand(() => new Promise(() => {}));
    const pending = call('get_url');
    await sleep(300);
    await session.close();
    const out = textOf(await pending);
    expect(out).toContain('get_url');
    expect(out).toMatch(/may or may not have run/);
  });

  it('tells the agent the browser hung up on purpose, and why, without waiting for a reconnect', async () => {
    const session = await openSession({ installId: install });
    session.onCommand(() => ({ accessScope: 'all', paused: false, commandCount: 0 }));
    await waitForBridge(h);
    const closed = new Promise<void>((r) => session.ws.once('close', () => r()));
    session.ws.close(4100, 'the user turned Control Mode off in the OnBridge panel');
    await closed;
    await sleep(200);

    const started = Date.now();
    const res = await call('get_url');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.result.isError).toBe(true);
    expect(textOf(res)).toMatch(/on purpose: the user turned Control Mode off/);
    expect(textOf(res)).toMatch(/will not reconnect by itself/);
  });

  it('describes a lost connection as something that comes back on its own', () => {
    const lost = notConnectedText('ABCD', { at: Date.now() - 3_000, code: 1006, reason: '', granted: true });
    expect(lost).toMatch(/connection was lost without a reason/);
    expect(lost).toMatch(/had given this agent control/);
    expect(lost).toMatch(/reconnects on its own/);
    expect(lost).toContain('ABCD');
    expect(notConnectedText('ABCD')).toMatch(/^The browser is not connected/);
  });
});
