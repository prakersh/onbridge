/**
 * Line diff between two serialised page views, rendered for an agent.
 *
 * A click that stays on the page used to return the whole page again. In real sessions 60% of those lines were identical to the reply before, and every reply is re-read on each later turn, so the repeats were most of what an agent session spent on onbridge.
 */

export type Op = { kind: 'eq' | 'del' | 'ins'; line: string };

/**
 * Myers' O(ND) line diff, after trimming the common prefix and suffix (a click usually changes one region). Returns null once more than `maxEdits` lines differ: past that point the changes are not worth sending instead of the page.
 */
export function diffLines(a: string[], b: string[], maxEdits: number): Op[] | null {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const middle = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf), maxEdits);
  if (!middle) return null;
  const eq = (line: string): Op => ({ kind: 'eq', line });
  return [...a.slice(0, pre).map(eq), ...middle, ...a.slice(a.length - suf).map(eq)];
}

function myers(a: string[], b: string[], maxEdits: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v for diagonals -d-1..d+1 as it was before step d, which is all backtracking reads.
  const trace: Int32Array[] = [];

  for (let d = 0; d <= Math.min(max, maxEdits); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
  }
  return null;
}

function backtrack(a: string[], b: string[], trace: Int32Array[], dEnd: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const prev = trace[d];
    const at = (k: number) => prev[k + d + 1];
    const k = x - y;
    const inserted = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = inserted ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    const startX = inserted ? prevX : prevX + 1;
    while (x > startX) {
      ops.push({ kind: 'eq', line: a[x - 1] });
      x--;
      y--;
    }
    ops.push(inserted ? { kind: 'ins', line: b[prevY] } : { kind: 'del', line: a[prevX] });
    x = prevX;
    y = prevY;
  }
  while (x > 0) {
    ops.push({ kind: 'eq', line: a[x - 1] });
    x--;
  }
  return ops.reverse();
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * `+` added, `-` removed, and a space for the unchanged lines that say where a change sits: its ancestors in the tree, found by indentation. Each run of other unchanged lines becomes one `…`.
 */
export function renderDiff(ops: Op[]): string {
  const show = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    const kind = ops[i].kind;
    if (kind === 'eq') continue;
    show[i] = true;
    // Ancestors live on the same side of the change: an added line's parents are in the new page, a removed line's in the old one.
    let want = indentOf(ops[i].line);
    for (let j = i - 1; j >= 0 && want > 0; j--) {
      const o = ops[j];
      if (o.kind !== 'eq' && o.kind !== kind) continue;
      const indent = indentOf(o.line);
      if (indent >= want) continue;
      want = indent;
      if (o.kind !== 'eq') continue;
      // An unchanged line already shown was shown with its own ancestors.
      if (show[j]) break;
      show[j] = true;
    }
  }

  const out: string[] = [];
  let skipped = false;
  for (let i = 0; i < ops.length; i++) {
    if (!show[i]) {
      skipped = true;
      continue;
    }
    if (skipped && out.length > 0) out.push('…');
    skipped = false;
    const mark = ops[i].kind === 'ins' ? '+' : ops[i].kind === 'del' ? '-' : ' ';
    out.push(mark + ops[i].line);
  }
  return out.join('\n');
}
