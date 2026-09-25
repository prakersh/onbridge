/**
 * The serializer's contract with malformed input.
 *
 * `serializeSnapshot` used to do `for (const node of snapshot.tree)` on
 * whatever an action tool handed it. When a click navigated, the extension
 * could not build a post-click snapshot and returned an acknowledgement
 * instead — so this threw `snapshot.tree is not iterable`, and that throw
 * travelled back to the agent as the *click's* failure. The click had already
 * happened. An agent that is told an action failed retries it, and retrying a
 * click that already went through is how an order gets placed twice.
 *
 * The real fix is upstream: action tools no longer pass non-snapshots here.
 * This is the last line of that defence, and it is cheap to keep.
 */

import { describe, it, expect } from 'vitest';
import { serializeSnapshot, serializeFindResults } from '../src/serializer.js';
import type { PageSnapshot, FindResult } from '../src/dom-types.js';

const snapshot = (over: Partial<PageSnapshot> = {}): PageSnapshot =>
  ({
    url: 'https://example.test/',
    title: 'Example',
    tree: [{ role: 'button', ref: 1, name: 'Buy' }],
    scroll: { percent: 0, pagesAbove: 0, pagesBelow: 0 },
    refCount: 1,
    ...over,
  }) as PageSnapshot;

describe('serializeSnapshot', () => {
  it('renders a normal snapshot', () => {
    const out = serializeSnapshot(snapshot());
    expect(out).toContain('[page] Example (https://example.test/)');
    expect(out).toContain('[button:1] "Buy"');
  });

  it('does not throw when there is no tree', () => {
    // The exact object an action used to return after navigating.
    const acked = { ok: true, action: 'click', navigated: true } as unknown as PageSnapshot;
    expect(() => serializeSnapshot(acked)).not.toThrow();
  });

  it('does not throw when the tree is not an array', () => {
    expect(() => serializeSnapshot(snapshot({ tree: 'nope' as never }))).not.toThrow();
  });

  it('drops separator glyphs and folds bare wrappers, and nothing else', () => {
    const out = serializeSnapshot(
      snapshot({
        tree: [
          {
            role: 'list',
            children: [
              { role: 'listitem', children: [{ role: 'link', ref: 1, name: 'home' }] },
              { role: 'listitem', children: [{ role: 'text', name: '-' }, { role: 'link', ref: 2, name: 'popular' }] },
            ],
          },
          { role: 'group', children: [{ role: 'group', children: [{ role: 'button', ref: 3, name: 'Post' }] }] },
          { role: 'group', children: [{ role: 'text', name: 'a' }, { role: 'text', name: 'b' }] },
          { role: 'text', name: 'Price - $5' },
        ],
      }),
    );
    expect(out).not.toContain('"-"');
    expect(out).toContain('\n  [button:3] "Post"');
    // A list item with one child keeps its line; a group with two children keeps its grouping.
    expect(out.match(/\[listitem\]/g)).toHaveLength(2);
    expect(out).toContain('\n  [group]\n    [text] "a"\n    [text] "b"');
    expect(out).toContain('[text] "Price - $5"');
    for (const ref of [1, 2, 3]) expect(out).toContain(`:${ref}]`);
  });

  it('does not throw when scroll state is missing', () => {
    expect(() => serializeSnapshot(snapshot({ scroll: undefined as never }))).not.toThrow();
  });
});

describe('serializeFindResults', () => {
  const base: FindResult = { ref: 3, role: 'link', name: 'Widget', context: 'in list' };

  it('carries a link destination, so the agent can navigate instead of clicking', () => {
    // A navigating click is the most failure-prone thing the bridge does.
    // Reading the href and going there directly avoids it entirely.
    const out = serializeFindResults([{ ...base, href: 'https://shop.test/widget?id=9' }]);
    expect(out).toContain('https://shop.test/widget?id=9');
  });

  it('omits the arrow when there is no href', () => {
    expect(serializeFindResults([base])).not.toContain('→');
  });

  it('survives a non-array', () => {
    expect(serializeFindResults(undefined as never)).toBe('No matches found.');
  });
});
