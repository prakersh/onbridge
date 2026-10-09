/**
 * The ledger that stands in for ref stability on an extension that renumbers refs on every capture.
 */

import { describe, it, expect } from 'vitest';
import { RefLedger, collectRefs, staleRefText } from '../src/refs.js';

const snapshot = (refs: number[]) => ({
  url: 'https://shop.test/',
  title: 'Shop',
  tree: refs.map((ref) => ({ role: 'button', ref, name: `b${ref}` })),
});

describe('RefLedger', () => {
  it('refuses everything until something has been issued', () => {
    const l = new RefLedger();
    expect(l.stale([1, 2])).toEqual([1, 2]);
  });

  it('accepts the refs the latest capture issued', () => {
    const l = new RefLedger();
    l.observe('snapshot', snapshot([3, 7]));
    expect(l.stale([3, 7])).toEqual([]);
    expect(l.stale([3, 8])).toEqual([8]);
  });

  it('refuses a ref from before the next capture, even if it is not in the new one', () => {
    const l = new RefLedger();
    l.observe('snapshot', snapshot([7]));
    l.observe('snapshot', snapshot([9]));
    expect(l.stale([7])).toEqual([7]);
    expect(l.stale([9])).toEqual([]);
  });

  it('keeps a ref current when the next capture issues it again', () => {
    // The post-click capture re-issues every surviving element's number, which is what makes "the rest of page view N still stands" true.
    const l = new RefLedger();
    l.observe('snapshot', snapshot([7]));
    l.observe('click', { ok: true, navigated: false, url: '', title: '', snapshot: snapshot([7, 8]) });
    expect(l.stale([7, 8])).toEqual([]);
  });

  it('treats a failed post-action capture as a capture', () => {
    const l = new RefLedger();
    l.observe('snapshot', snapshot([7]));
    l.observe('click', { ok: true, navigated: true, url: '', title: '', snapshotError: 'the page was still loading' });
    expect(l.stale([7])).toEqual([7]);
  });

  it('adds refs from find, list_actions and dom_query to the current capture', () => {
    const l = new RefLedger();
    l.observe('snapshot', snapshot([1]));
    l.observe('find', [{ ref: 12, role: 'link', name: 'x', context: '' }]);
    l.observe('list_actions', { actions: [{ ref: 13, tag: 'a' }] });
    l.observe('dom_query', { matches: 1, results: [{ index: 0, ref: 14, tag: 'a', text: '' }] });
    expect(l.stale([1, 12, 13, 14])).toEqual([]);
  });

  it('does not count a capture that type, extract_text or get_url are not', () => {
    const l = new RefLedger();
    l.observe('snapshot', snapshot([5]));
    l.observe('type', { success: true, value: 'x' });
    l.observe('extract_text', { text: 'x', chars: 1, truncated: false });
    l.observe('get_url', { url: 'https://shop.test/', title: 'Shop' });
    expect(l.stale([5])).toEqual([]);
  });

  it('finds every ref a command names', () => {
    expect(RefLedger.refsIn({ ref: 1 })).toEqual([1]);
    expect(RefLedger.refsIn({ fromRef: 2, toRef: 3 })).toEqual([2, 3]);
    expect(RefLedger.refsIn({ target: 4 })).toEqual([4]);
    expect(RefLedger.refsIn({ fields: [{ ref: 5, value: 'a' }, { ref: 6, value: 'b' }] })).toEqual([5, 6]);
    expect(RefLedger.refsIn({ text: 'ref 7', selector: '[ref]' })).toEqual([]);
  });
});

describe('collectRefs', () => {
  it('walks nested trees and arrays', () => {
    const tree = { tree: [{ role: 'main', children: [{ role: 'button', ref: 2 }, { role: 'link', ref: 3, children: [{ ref: 4 }] }] }] };
    expect(collectRefs(tree).sort()).toEqual([2, 3, 4]);
  });

  it('ignores non-numeric ref fields and scalars', () => {
    expect(collectRefs({ ref: 'x', a: 1, b: null })).toEqual([]);
    expect(collectRefs('text')).toEqual([]);
  });
});

describe('staleRefText', () => {
  it('names the refs, the extension version and the way out', () => {
    const t = staleRefText([7], '0.5.2');
    expect(t).toMatch(/^Ref 7 was/);
    expect(t).toContain('v0.5.2');
    expect(t).toMatch(/fresh snapshot or find/);
    expect(staleRefText([7, 9])).toMatch(/^Refs 7, 9 were/);
  });
});
