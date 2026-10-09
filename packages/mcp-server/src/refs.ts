/**
 * Which refs an agent may still use, kept on the server for an extension that renumbers them.
 *
 * Extensions before `stable-refs` rebuild their ref map from 1 on every page capture: a snapshot, and the capture after a click, scroll, dismissal or navigation. A ref issued before that capture then resolves to whichever element has its number now, and the agent types into or clicks something it never meant to, with no error anywhere. The extension cannot tell, so the server refuses on its behalf: every ref it hands out is remembered with the generation of the capture it belongs to, and a ref from an earlier generation, or one this session never issued, is refused before anything is sent.
 *
 * Not applied to an extension that announces `stable-refs`: that one keeps numbers across captures and refuses unknown refs itself, with the truth about the page in hand.
 */
export class RefLedger {
  private generation = 0;
  private issued = new Map<number, number>();

  /** Every ref a command names, in each place a tool puts one. */
  static refsIn(params: Record<string, unknown>): number[] {
    const out: number[] = [];
    for (const key of ['ref', 'fromRef', 'toRef', 'target']) {
      if (typeof params[key] === 'number') out.push(params[key] as number);
    }
    if (Array.isArray(params.fields)) {
      for (const f of params.fields as Array<{ ref?: unknown }>) {
        if (typeof f?.ref === 'number') out.push(f.ref);
      }
    }
    return out;
  }

  /**
   * Records what a result handed out. A capture starts a new generation first, so the refs it carries are the only ones current afterwards. `snapshotError` counts as a capture: the extension rebuilt its map before the capture failed.
   */
  observe(action: string, data: unknown): void {
    const d = data as { snapshot?: unknown; snapshotError?: unknown } | null;
    if (action === 'snapshot' || (d && typeof d === 'object' && ('snapshot' in d || 'snapshotError' in d))) {
      this.generation++;
    }
    for (const ref of collectRefs(data)) this.issued.set(ref, this.generation);
  }

  /** The refs among `refs` that were issued before the latest capture, or never. */
  stale(refs: number[]): number[] {
    return refs.filter((r) => this.issued.get(r) !== this.generation);
  }
}

/** Every numeric `ref` field anywhere in a result: snapshot trees, find results, action lists, query rows. */
export function collectRefs(value: unknown, depth = 0): number[] {
  if (depth > 64 || value == null || typeof value !== 'object') return [];
  const out: number[] = [];
  if (Array.isArray(value)) {
    for (const v of value) out.push(...collectRefs(v, depth + 1));
    return out;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.ref === 'number') out.push(obj.ref);
  for (const v of Object.values(obj)) if (v && typeof v === 'object') out.push(...collectRefs(v, depth + 1));
  return out;
}

/** What the agent is told, composed here and never from page text. */
export function staleRefText(refs: number[], extensionVersion?: string): string {
  const list = refs.length === 1 ? `Ref ${refs[0]} was` : `Refs ${refs.join(', ')} were`;
  return (
    `${list} issued before the latest page capture, or not by this session. This browser extension` +
    `${extensionVersion ? ` (v${extensionVersion})` : ''} renumbers refs every time a page is captured, so an older ref may now ` +
    'point at a different element. Nothing was sent to the page. Use refs from the latest page view, or take a fresh ' +
    'snapshot or find. Updating the extension makes refs stable across captures.'
  );
}
