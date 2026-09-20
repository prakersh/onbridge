import type { DomNode, PageSnapshot, FindResult, ScrollState } from './dom-types.js';

export function serializeSnapshot(snapshot: PageSnapshot): string {
  const lines: string[] = [];
  lines.push(`[page] ${snapshot?.title ?? ''} (${snapshot?.url ?? ''})`);

  // Defensive rather than trusting: `for (const node of snapshot.tree)` on an
  // object with no `tree` throws "snapshot.tree is not iterable", and that throw
  // used to travel back to the agent as the *action's* failure — reporting a
  // click that had already landed as an error. The shape check is the last line
  // of that defence; the first is that action tools no longer pass a
  // non-snapshot here at all.
  const tree = Array.isArray(snapshot?.tree) ? snapshot.tree : [];
  for (const node of tree) {
    serializeNode(node, 1, lines);
  }

  const scroll: ScrollState | undefined = snapshot?.scroll;
  if (scroll && scroll.pagesBelow > 0) {
    lines.push(
      `  [scroll] ${scroll.percent}% · ${scroll.pagesBelow} page${scroll.pagesBelow === 1 ? '' : 's'} below`,
    );
  }

  return lines.join('\n');
}

function serializeNode(node: DomNode, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth);
  const refTag = node.ref != null ? `:${node.ref}` : '';
  let label = `[${node.role}${refTag}]`;

  const parts: string[] = [];
  if (node.name) parts.push(`"${node.name}"`);
  if (node.value != null) parts.push(`value="${node.value}"`);
  if (node.placeholder) parts.push(`placeholder="${node.placeholder}"`);
  if (node.checked != null) parts.push(`checked=${node.checked}`);
  if (node.disabled) parts.push('disabled');
  if (node.expanded != null) parts.push(`expanded=${node.expanded}`);
  if (node.selected) parts.push('selected');

  if (parts.length > 0) {
    label += ' ' + parts.join(' ');
  }

  lines.push(`${indent}${label}`);

  if (node.children) {
    for (const child of node.children) {
      serializeNode(child, depth + 1, lines);
    }
  }
}

export function serializeFindResults(results: FindResult[]): string {
  if (!Array.isArray(results) || results.length === 0) return 'No matches found.';
  return results
    .map((r) => {
      // The href is what lets the agent `navigate` straight to a result instead
      // of clicking through it, so it belongs on the line rather than behind a
      // second call.
      const href = r.href ? ` → ${r.href}` : '';
      return `[${r.role}:${r.ref}] "${r.name}" — ${r.context}${href}`;
    })
    .join('\n');
}
