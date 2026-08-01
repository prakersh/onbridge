import type { DomNode, PageSnapshot, FindResult, ScrollState } from './dom-types.js';

export function serializeSnapshot(snapshot: PageSnapshot): string {
  const lines: string[] = [];
  lines.push(`[page] ${snapshot.title} (${snapshot.url})`);

  for (const node of snapshot.tree) {
    serializeNode(node, 1, lines);
  }

  const { percent, pagesBelow } = snapshot.scroll;
  if (pagesBelow > 0) {
    lines.push(`  [scroll] ${percent}% · ${pagesBelow} page${pagesBelow === 1 ? '' : 's'} below`);
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
  if (results.length === 0) return 'No matches found.';
  return results
    .map((r) => `[${r.role}:${r.ref}] "${r.name}" — ${r.context}`)
    .join('\n');
}
