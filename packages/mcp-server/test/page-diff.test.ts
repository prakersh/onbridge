/**
 * The change-only page replies (`src/tools/page-diff.ts`).
 *
 * The contract that matters for an agent: the last whole page it was sent plus the change-only reply is exactly the page's current text. A diff that drops a line, reorders one or invents one tells the agent something false about the page it is acting on. So besides named cases, these compare against a brute-force answer on thousands of seeded random pages; a failure names the seed that reproduces it.
 */

import { describe, it, expect } from 'vitest';
import { serializeSnapshot } from '@onbridge/shared';
import type { DomNode, PageSnapshot } from '@onbridge/shared';
import { diffLines, renderDiff, type Op } from '../src/tools/page-diff.js';

/** mulberry32: small, fast and seeded, so every random case can be replayed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)] };
}

const newSide = (ops: Op[]) => ops.filter((o) => o.kind !== 'del').map((o) => o.line);
const oldSide = (ops: Op[]) => ops.filter((o) => o.kind !== 'ins').map((o) => o.line);
const editCount = (ops: Op[]) => ops.filter((o) => o.kind !== 'eq').length;

/** Fewest insertions plus deletions, by the textbook LCS table. The answer Myers must match. */
function minimalEdits(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return a.length + b.length - 2 * dp[0][0];
}

function diffOrThrow(a: string[], b: string[]): Op[] {
  const ops = diffLines(a, b, a.length + b.length);
  if (!ops) throw new Error('diff gave up with an unlimited budget');
  return ops;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** The unchanged lines that should be shown: every ancestor of every change, on the change's own side. A shortcut that stopped at a line already shown once missed old-page ancestors of a removed line. */
function expectedContext(ops: Op[]): Set<number> {
  const shown = new Set<number>();
  ops.forEach((op, i) => {
    if (op.kind === 'eq') return;
    let want = indentOf(op.line);
    for (let j = i - 1; j >= 0 && want > 0; j--) {
      const o = ops[j];
      if (o.kind !== 'eq' && o.kind !== op.kind) continue;
      if (indentOf(o.line) >= want) continue;
      want = indentOf(o.line);
      if (o.kind === 'eq') shown.add(j);
    }
  });
  return shown;
}

/** Checks a rendering line by line against the ops it came from. */
function checkRender(ops: Op[], out: string) {
  const context = expectedContext(ops);
  const expected: string[] = [];
  let skipped = false;
  ops.forEach((op, i) => {
    const show = op.kind !== 'eq' || context.has(i);
    if (!show) {
      skipped = true;
      return;
    }
    if (skipped && expected.length > 0) expected.push('…');
    skipped = false;
    expected.push((op.kind === 'ins' ? '+' : op.kind === 'del' ? '-' : ' ') + op.line);
  });
  expect(out).toBe(expected.join('\n'));
  if (out) {
    expect(out.startsWith('…')).toBe(false);
    expect(out.endsWith('…')).toBe(false);
    expect(out).not.toContain('…\n…');
  }
}

describe('diffLines: named cases', () => {
  it('sees no change between identical pages', () => {
    const page = ['[page] A (https://a.test/)', '  [main]', '    [button:1] "Go"'];
    const ops = diffOrThrow(page, [...page]);
    expect(editCount(ops)).toBe(0);
    expect(newSide(ops)).toEqual(page);
  });

  it('handles empty pages on either side', () => {
    expect(diffOrThrow([], [])).toEqual([]);
    expect(diffOrThrow([], ['a', 'b']).map((o) => o.kind)).toEqual(['ins', 'ins']);
    expect(diffOrThrow(['a', 'b'], []).map((o) => o.kind)).toEqual(['del', 'del']);
  });

  it('shows a changed attribute as the old line removed and the new one added, in that order', () => {
    const ops = diffOrThrow(['  [main]', '    [button:7] "Reply"', '  [footer]'], ['  [main]', '    [button:7] "Reply" expanded=true', '  [footer]']);
    expect(ops).toEqual([
      { kind: 'eq', line: '  [main]' },
      { kind: 'del', line: '    [button:7] "Reply"' },
      { kind: 'ins', line: '    [button:7] "Reply" expanded=true' },
      { kind: 'eq', line: '  [footer]' },
    ]);
  });

  it('is exact when the common prefix and suffix overlap', () => {
    // a trimmed prefix and suffix could otherwise count the same line twice
    for (const [a, b] of [
      [['x', 'x'], ['x', 'x', 'x']],
      [['x', 'x', 'x'], ['x']],
      [['x', 'y', 'x'], ['x']],
      [['[listitem]', '[listitem]'], ['[listitem]', '[listitem]', '[listitem]', '[listitem]']],
    ]) {
      const ops = diffOrThrow(a, b);
      expect(oldSide(ops)).toEqual(a);
      expect(newSide(ops)).toEqual(b);
      expect(editCount(ops)).toBe(minimalEdits(a, b));
    }
  });

  it('keeps repeated lines apart, as on a list of identical items', () => {
    const a = ['[list]', '  [listitem]', '    [text] "-"', '  [listitem]', '    [text] "-"'];
    const b = ['[list]', '  [listitem]', '    [text] "-"', '  [listitem]', '    [link:9] "new"', '  [listitem]', '    [text] "-"'];
    const ops = diffOrThrow(a, b);
    expect(newSide(ops)).toEqual(b);
    expect(editCount(ops)).toBe(2);
  });

  it('gives up past the edit budget, and not before', () => {
    const a = ['a', 'b', 'c', 'd'];
    const b = ['a', 'x', 'y', 'd'];
    // two lines replaced: four edits
    expect(diffLines(a, b, 4)).not.toBeNull();
    expect(diffLines(a, b, 3)).toBeNull();
    expect(diffLines(a, [...a], 0)).not.toBeNull();
    expect(diffLines(a, [...a, 'e'], 0)).toBeNull();
  });
});

describe('diffLines: seeded random pages against brute force', () => {
  it('reproduces both pages and is minimal, on 3000 random pairs', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed);
      // a tiny alphabet, so repeated lines are the norm and not the exception
      const alphabet = ['  [group]', '  [listitem]', '    [text] "-"', '    [link:1] "home"', '    [button:2] "Reply"', '  [main]', 'x', 'y'];
      const a = Array.from({ length: r.int(40) }, () => r.pick(alphabet));
      const b = [...a];
      for (let k = r.int(12); k > 0; k--) {
        const at = r.int(b.length + 1);
        const what = r.int(3);
        if (what === 0) b.splice(at, 0, r.pick(alphabet));
        else if (what === 1 && b.length) b.splice(Math.min(at, b.length - 1), 1);
        else if (b.length) b[Math.min(at, b.length - 1)] = r.pick(alphabet);
      }
      const ops = diffLines(a, b, a.length + b.length);
      const where = `seed ${seed}`;
      expect(ops, where).not.toBeNull();
      expect(oldSide(ops!), where).toEqual(a);
      expect(newSide(ops!), where).toEqual(b);
      expect(editCount(ops!), where).toBe(minimalEdits(a, b));
      // with a budget of exactly the minimum it still succeeds; one less and it gives up
      const d = minimalEdits(a, b);
      expect(diffLines(a, b, d), where).not.toBeNull();
      if (d > 0) expect(diffLines(a, b, d - 1), where).toBeNull();
    }
  });
});

describe('renderDiff', () => {
  it('is empty when nothing changed', () => {
    expect(renderDiff(diffOrThrow(['a', '  b'], ['a', '  b']))).toBe('');
  });

  it('places a change under its ancestors, skips unrelated lines, and marks the gap once', () => {
    const a = ['[page] P (https://p.test/)', '  [navigation]', '    [link:1] "home"', '    [link:2] "all"', '  [main]', '    [article]', '      [button:3] "Reply"', '    [text] "footer note"'];
    const b = [...a.slice(0, 6), '      [button:3] "Reply" expanded=true', '      [textbox:4] "Your reply"', a[7]];
    const out = renderDiff(diffOrThrow(a, b));
    expect(out).toBe(
      [
        ' [page] P (https://p.test/)',
        '…',
        '   [main]',
        '     [article]',
        '-      [button:3] "Reply"',
        '+      [button:3] "Reply" expanded=true',
        '+      [textbox:4] "Your reply"',
      ].join('\n'),
    );
  });

  it("locates a removed line by the old page's ancestors and an added one by the new page's", () => {
    // The parent itself changed: the removed child sits under the removed parent, the added child under the added one.
    const a = ['[page]', '  [form:1] "Old"', '    [textbox:2] "a"'];
    const b = ['[page]', '  [form:5] "New"', '    [textbox:6] "b"'];
    const ops = diffOrThrow(a, b);
    checkRender(ops, renderDiff(ops));
  });

  it('matches a brute-force rendering on 2000 random tree-shaped pages', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const r = rng(seed * 7919);
      const page = (n: number) => {
        const lines = ['[page] T (https://t.test/)'];
        let depth = 1;
        for (let i = 0; i < n; i++) {
          depth = Math.max(1, Math.min(depth + r.int(3) - 1, 6));
          lines.push(`${'  '.repeat(depth)}[${r.pick(['group', 'listitem', 'link', 'text'])}${r.int(2) ? `:${r.int(50)}` : ''}]`);
        }
        return lines;
      };
      const a = page(r.int(60));
      const b = [...a];
      for (let k = r.int(8); k > 0; k--) {
        const at = 1 + r.int(b.length);
        if (r.int(2)) b.splice(at, 0, `${'  '.repeat(1 + r.int(6))}[button:${100 + r.int(50)}]`);
        else if (b.length > 1) b.splice(Math.min(at, b.length - 1), 1);
      }
      const ops = diffOrThrow(a, b);
      try {
        checkRender(ops, renderDiff(ops));
      } catch (err) {
        throw new Error(`seed ${seed}: ${(err as Error).message}`);
      }
    }
  });
});

describe('real snapshots, mutated the way pages change', () => {
  const r = rng(424242);
  let nextRef = 1;
  const tree = (depth: number): DomNode[] =>
    Array.from({ length: 1 + r.int(depth > 3 ? 2 : 4) }, () => {
      const roll = r.int(6);
      if (depth < 5 && roll < 2) return { role: r.pick(['main', 'list', 'listitem', 'region', 'group']), name: r.int(2) ? 'section' : undefined, children: tree(depth + 1) };
      if (roll < 4) return { role: r.pick(['link', 'button', 'textbox']), ref: nextRef++, name: `item ${nextRef}` };
      return { role: 'text', name: r.pick(['-', '|', 'hello', 'Price - $5', 'comment body']) };
    });
  const snap = (nodes: DomNode[]): string =>
    serializeSnapshot({ url: 'https://r.test/', title: 'R', tree: nodes, scroll: { percent: 0, pagesAbove: 0, pagesBelow: 0 }, refCount: 0 } as PageSnapshot);

  const mutate = (nodes: DomNode[]): DomNode[] => {
    const copy: DomNode[] = structuredClone(nodes);
    const all: DomNode[][] = [];
    const walk = (list: DomNode[]) => {
      all.push(list);
      for (const n of list) if (n.children) walk(n.children);
    };
    walk(copy);
    const list = r.pick(all);
    const at = r.int(list.length + 1);
    switch (r.int(5)) {
      case 0: // content appears, like a reply box opening
        list.splice(at, 0, { role: 'textbox', ref: nextRef++, name: 'Your reply' });
        break;
      case 1: // content goes away
        if (list.length) list.splice(Math.min(at, list.length - 1), 1);
        break;
      case 2: // a control changes state
        if (list.length) list[Math.min(at, list.length - 1)].expanded = true;
        break;
      case 3: // a subtree gets wrapped in a new container, which re-indents all of it
        if (list.length) list.splice(0, list.length, { role: 'region', name: 'editor', children: [...list] });
        break;
      default: // loaded content, a whole subtree at once
        list.splice(at, 0, ...tree(3));
    }
    return copy;
  };

  it('reproduces the new page exactly across 300 chains of mutations', () => {
    for (let i = 0; i < 300; i++) {
      let nodes = tree(0);
      let before = snap(nodes);
      for (let step = 0; step < 5; step++) {
        nodes = mutate(nodes);
        const after = snap(nodes);
        const ops = diffOrThrow(before.split('\n'), after.split('\n'));
        expect(newSide(ops).join('\n')).toBe(after);
        expect(oldSide(ops).join('\n')).toBe(before);
        checkRender(ops, renderDiff(ops));
        before = after;
      }
    }
  });
});

describe('cost', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `${'  '.repeat(1 + (i % 5))}[link:${i}] "item ${i}"`);

  it('diffs a 5000-line page with a local change quickly', () => {
    const b = [...big];
    b.splice(2500, 1, '      [textbox:9999] "Your reply"');
    const t0 = performance.now();
    const ops = diffLines(big, b, Math.floor(b.length / 2));
    expect(ops).not.toBeNull();
    expect(editCount(ops!)).toBe(2);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('gives up quickly when a 5000-line page changed completely', () => {
    const b = big.map((l) => l + ' changed');
    const t0 = performance.now();
    expect(diffLines(big, b, Math.floor(b.length / 2))).toBeNull();
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
