import { getElementByRef, captureSnapshot, getRefMap } from './dom-capture.js';
import type { PageSnapshot } from '@onbridge/shared';

export class CommandExecutor {
  async execute(action: string, params: Record<string, unknown>): Promise<unknown> {
    switch (action) {
      case 'snapshot':
        return captureSnapshot(params.target as number | undefined, params.depth as number | undefined, params.compact as boolean | undefined);

      case 'find': {
        const { findElements } = await import('./dom-capture.js');
        return findElements(
          String(params.text ?? ''),
          params.role as string | undefined,
          params.selector as string | undefined,
        );
      }

      case 'get_text':
        return this.getText(params.ref as number);

      case 'get_url':
        return { url: window.location.href, title: document.title };

      case 'click':
        return this.click(params);

      case 'click_by_text':
        return this.clickByText(params);

      case 'type':
        return this.typeText(params);

      case 'fill_form':
        return this.fillForm(params);

      case 'select':
        return this.selectOption(params);

      case 'hover':
        return this.hover(params.ref as number);

      case 'scroll':
        return this.scroll(params);

      case 'press_key':
        return this.pressKey(params);

      case 'drag':
        return this.drag(params);

      case 'evaluate':
        return this.evaluate(params);

      case 'wait':
        return this.wait(params);

      case 'dom_query':
        return this.domQuery(params);

      case 'dismiss_modal':
        return this.dismissModal(params);

      case 'extract_text':
        return this.extractText(params);

      case 'list_actions':
        return this.listActions();

      case 'highlight':
        return this.highlight(params);

      case 'screenshot':
        return this.screenshot();

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  /**
   * Reads readable text from the page or a subtree, with tables rendered as
   * markdown. A snapshot is the right tool for *acting* on a page; for reading
   * an article or a results table it wastes most of its tokens on structure.
   */
  private extractText(params: Record<string, unknown>): {
    text: string;
    truncated: boolean;
    chars: number;
  } {
    const root = params.ref != null ? (this.getEl(params.ref as number) as HTMLElement) : document.body;
    const maxChars = (params.maxChars as number) ?? 20_000;

    const parts: string[] = [];
    const seenTables = new Set<Element>();

    for (const table of root.querySelectorAll('table')) {
      seenTables.add(table);
    }

    const walk = (node: Element) => {
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'NOSCRIPT') return;
      try {
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return;
      } catch {
        /* detached */
      }

      if (node.tagName === 'TABLE' && seenTables.has(node)) {
        parts.push(this.tableToMarkdown(node as HTMLTableElement));
        return;
      }

      let ownText = '';
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) ownText += child.textContent ?? '';
      }
      ownText = ownText.replace(/\s+/g, ' ').trim();

      if (ownText) {
        const heading = /^H([1-6])$/.exec(node.tagName);
        parts.push(heading ? `${'#'.repeat(Number(heading[1]))} ${ownText}` : ownText);
      }

      for (const child of node.children) walk(child);
      if (node.shadowRoot) for (const child of node.shadowRoot.children) walk(child);
    };

    walk(root);

    const full = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return {
      text: full.slice(0, maxChars),
      truncated: full.length > maxChars,
      chars: full.length,
    };
  }

  private tableToMarkdown(table: HTMLTableElement): string {
    const rows = Array.from(table.rows).slice(0, 200);
    if (rows.length === 0) return '';

    const cellText = (c: HTMLTableCellElement) =>
      (c.textContent ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

    const lines = rows.map((r) => `| ${Array.from(r.cells).map(cellText).join(' | ')} |`);
    // Insert the markdown separator after the header row so the table renders.
    const headerCols = rows[0].cells.length;
    lines.splice(1, 0, `|${' --- |'.repeat(headerCols)}`);
    return lines.join('\n');
  }

  /**
   * The interactive elements only, without the surrounding tree. Answers "what
   * can I do here?" at a fraction of a snapshot's size.
   */
  private async listActions(): Promise<{ actions: unknown[] }> {
    const { captureSnapshot, getRefMap } = await import('./dom-capture.js');
    captureSnapshot();

    const actions: unknown[] = [];
    for (const [ref, el] of getRefMap()) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const tag = el.tagName.toLowerCase();
      const label =
        el.getAttribute('aria-label') ??
        (el as HTMLInputElement).placeholder ??
        (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

      actions.push({
        ref,
        tag,
        label: label || undefined,
        type: (el as HTMLInputElement).type || undefined,
        disabled: (el as HTMLInputElement).disabled || undefined,
        inViewport: rect.top >= 0 && rect.top < window.innerHeight,
      });
    }
    return { actions };
  }

  /**
   * Draws a temporary outline around an element. Useful when the user is
   * watching and needs to see what the agent is about to act on.
   */
  private highlight(params: Record<string, unknown>): { success: boolean } {
    const el = this.getEl(params.ref as number) as HTMLElement;
    const ms = (params.durationMs as number) ?? 2000;

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const previous = el.style.outline;
    const previousOffset = el.style.outlineOffset;
    el.style.outline = '3px solid #00d4aa';
    el.style.outlineOffset = '2px';

    setTimeout(() => {
      el.style.outline = previous;
      el.style.outlineOffset = previousOffset;
    }, ms);

    return { success: true };
  }

  private getText(ref: number): { text: string } {
    const el = this.getEl(ref);
    return { text: el.textContent?.trim() ?? '' };
  }

  private async click(params: Record<string, unknown>): Promise<PageSnapshot> {
    const el = this.getEl(params.ref as number) as HTMLElement;
    const button = (params.button as string) ?? 'left';
    const buttonNum = button === 'right' ? 2 : button === 'middle' ? 1 : 0;

    el.scrollIntoView({ behavior: 'instant', block: 'center' });

    const urlBefore = window.location.href;

    if (params.doubleClick) {
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: buttonNum }));
    } else {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: buttonNum }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: buttonNum }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: buttonNum }));
    }

    await this.settle();

    // If URL didn't change and element is a link, follow href directly
    if (window.location.href === urlBefore && el.tagName === 'A') {
      const href = (el as HTMLAnchorElement).href;
      if (href && !href.startsWith('javascript:') && href !== urlBefore) {
        window.location.href = href;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    return captureSnapshot();
  }

  private async clickByText(params: Record<string, unknown>): Promise<PageSnapshot> {
    const text = String(params.text ?? '');
    const role = params.role as string | undefined;
    const index = (params.index as number) ?? 0;

    const roleMatches: HTMLElement[] = [];
    const allMatches: HTMLElement[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let current = walker.nextNode() as HTMLElement | null;

    while (current) {
      const elText = current.textContent?.trim() ?? '';
      if (elText.toLowerCase().includes(text.toLowerCase())) {
        const style = window.getComputedStyle(current);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          // Prefer leaf-level matches (most specific)
          const childrenWithText = Array.from(current.children).filter(
            (c) => c.textContent?.trim().toLowerCase().includes(text.toLowerCase())
          );
          if (childrenWithText.length === 0) {
            allMatches.push(current);
            if (role) {
              const elRole = current.getAttribute('role') ?? current.tagName.toLowerCase();
              if (elRole === role || current.tagName.toLowerCase() === role) {
                roleMatches.push(current);
              }
            }
          }
        }
      }
      current = walker.nextNode() as HTMLElement | null;
    }

    // Use role-matched candidates if any, otherwise fall back to all matches
    const candidates = (role && roleMatches.length > 0) ? roleMatches : allMatches;

    if (candidates.length === 0) {
      throw new Error(`No element found with text "${text}"`);
    }

    const target = candidates[Math.min(index, candidates.length - 1)];
    target.scrollIntoView({ behavior: 'instant', block: 'center' });
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await this.settle();
    return captureSnapshot();
  }

  private async domQuery(params: Record<string, unknown>): Promise<unknown> {
    const selector = params.selector as string;
    const action = (params.action as string) ?? 'list';
    const index = (params.index as number) ?? 0;

    const elements = Array.from(document.querySelectorAll(selector));
    if (elements.length === 0) {
      return { matches: 0, results: [] };
    }

    if (action === 'click') {
      const target = elements[Math.min(index, elements.length - 1)] as HTMLElement;
      target.scrollIntoView({ behavior: 'instant', block: 'center' });
      target.click();
      await this.settle();
      return captureSnapshot();
    }

    if (action === 'text') {
      const target = elements[Math.min(index, elements.length - 1)];
      return { text: target.textContent?.trim() ?? '' };
    }

    // action === 'list'
    const map = getRefMap();
    const results = elements.slice(0, 20).map((el, i) => {
      let ref: number | undefined;
      for (const [r, mapped] of map) {
        if (mapped === el) { ref = r; break; }
      }
      return {
        index: i,
        ref,
        tag: el.tagName.toLowerCase(),
        text: (el.textContent?.trim() ?? '').slice(0, 80),
        id: el.id || undefined,
      };
    });

    return { matches: elements.length, results };
  }

  private async dismissModal(params: Record<string, unknown>): Promise<PageSnapshot> {
    const searchText = params.text as string | undefined;

    const dismissPatterns = [
      'No thanks', 'No, thanks', 'Close', 'Dismiss', 'Not now',
      'Skip', 'Cancel', 'Maybe later', 'Decline', 'Reject all',
      'Reject', 'No, thank you', 'Continue without', 'Not interested',
    ];
    const dismissSelectors = [
      // Cookie consent frameworks
      '#onetrust-reject-all-handler',
      '#onetrust-accept-btn-handler',
      '[data-testid="cookie-policy-manage-dialog-btn-reject-all"]',
      '.cookie-banner button[data-action="reject"]',
      '#CybotCookiebotDialogBodyButtonDecline',
      '.cc-deny', '.cc-dismiss',
      // Generic modal/dialog close
      '[aria-label="Close"]',
      '[aria-label="Dismiss"]',
      '[aria-label="close"]',
      '[role="dialog"] button[aria-label*="close" i]',
      '[role="dialog"] button[aria-label*="dismiss" i]',
      '[role="dialog"] button[aria-label*="reject" i]',
      '.modal-close',
      '[data-dismiss]',
      '[data-dismiss="modal"]',
      'button.close',
      '.close-button',
      // Overlay/backdrop close buttons
      '.overlay-close',
      '[data-close]',
      '[data-testid="close-button"]',
    ];

    let target: HTMLElement | null = null;

    // If specific text provided, search broadly (not just buttons)
    if (searchText) {
      // First try exact selectors with the text
      const exactSelectors = [
        `button:not([disabled])`,
        `a`,
        `[role="button"]`,
        `input[type="button"]`,
        `input[type="submit"]`,
        `span[onclick]`,
        `div[onclick]`,
        `[tabindex]`,
      ];
      for (const sel of exactSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const t = el.textContent?.trim() ?? '';
          if (t.toLowerCase().includes(searchText.toLowerCase())) {
            const style = window.getComputedStyle(el as HTMLElement);
            if (style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0) {
              target = el as HTMLElement;
              break;
            }
          }
        }
        if (target) break;
      }

      // Broaden: any visible element with cursor:pointer and matching text
      if (!target) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode() as HTMLElement | null;
        while (node) {
          const nodeText = node.textContent?.trim() ?? '';
          if (nodeText.toLowerCase().includes(searchText.toLowerCase())) {
            const style = window.getComputedStyle(node);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.cursor === 'pointer') {
              const kids = Array.from(node.children).filter(
                c => c.textContent?.trim().toLowerCase().includes(searchText.toLowerCase())
              );
              if (kids.length === 0) {
                target = node;
                break;
              }
            }
          }
          node = walker.nextNode() as HTMLElement | null;
        }
      }
    }

    // Try well-known dismiss selectors
    if (!target) {
      for (const sel of dismissSelectors) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el) {
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            target = el;
            break;
          }
        }
      }
    }

    // Try dismiss text patterns
    if (!target) {
      for (const pattern of dismissPatterns) {
        const buttons = document.querySelectorAll('button, a, [role="button"], input[type="button"], [tabindex], span[onclick], div[onclick]');
        for (const btn of buttons) {
          const btnText = btn.textContent?.trim() ?? '';
          if (btnText.toLowerCase() === pattern.toLowerCase() ||
              (btnText.length < 40 && btnText.toLowerCase().includes(pattern.toLowerCase()))) {
            const style = window.getComputedStyle(btn as HTMLElement);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              target = btn as HTMLElement;
              break;
            }
          }
        }
        if (target) break;
      }
    }

    // Try × or ✕ close buttons
    if (!target) {
      const closeChars = ['×', '✕', '✖', '✗', '╳'];
      const buttons = document.querySelectorAll('button, [role="button"], a');
      for (const btn of buttons) {
        const btnText = btn.textContent?.trim() ?? '';
        if (closeChars.includes(btnText)) {
          const style = window.getComputedStyle(btn as HTMLElement);
          if (style.display !== 'none') {
            target = btn as HTMLElement;
            break;
          }
        }
      }
    }

    if (!target) {
      throw new Error('No dismissible modal/dialog found on the page.');
    }

    target.scrollIntoView({ behavior: 'instant', block: 'center' });
    target.click();
    await this.settle();
    return captureSnapshot();
  }

  private async typeText(params: Record<string, unknown>): Promise<{ success: boolean }> {
    const el = this.getEl(params.ref as number) as HTMLInputElement;
    el.focus();

    if (params.clear) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const text = params.text as string;
    for (const char of text) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      el.value += char;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));

    if (params.submit) {
      const form = el.closest('form');
      if (form) {
        try { form.requestSubmit(); } catch {
          const submitBtn = form.querySelector<HTMLElement>('[type="submit"], button:not([type="button"])');
          if (submitBtn) {
            submitBtn.click();
          } else {
            form.submit();
          }
        }
      } else {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      }
    }

    return { success: true };
  }

  private async fillForm(params: Record<string, unknown>): Promise<{ filled: number }> {
    const fields = params.fields as Array<{ ref: number; value: string }>;
    let filled = 0;

    for (const field of fields) {
      const el = getElementByRef(field.ref) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | undefined;
      if (!el) continue;

      el.focus();

      if (el.tagName === 'SELECT') {
        (el as HTMLSelectElement).value = field.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        (el as HTMLInputElement).value = field.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      filled++;
    }

    if (params.submit) {
      const firstField = fields[0];
      if (firstField) {
        const el = getElementByRef(firstField.ref);
        const form = el?.closest('form');
        if (form) {
          try { form.requestSubmit(); } catch { form.submit(); }
        }
      }
    }

    return { filled };
  }

  private selectOption(params: Record<string, unknown>): { success: boolean } {
    const el = this.getEl(params.ref as number) as HTMLSelectElement;
    const values = Array.isArray(params.value) ? params.value as string[] : [params.value as string];

    for (const opt of el.options) {
      opt.selected = values.includes(opt.value) || values.includes(opt.textContent?.trim() ?? '');
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true };
  }

  private hover(ref: number): { success: boolean } {
    const el = this.getEl(ref) as HTMLElement;
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return { success: true };
  }

  private async scroll(params: Record<string, unknown>): Promise<PageSnapshot> {
    const direction = params.direction as string;
    const amount = params.amount ?? 'page';
    const ref = params.ref as number | undefined;

    let target: Element | Window = window;
    if (ref != null) {
      target = this.getEl(ref);
    }

    let pixels: number;
    if (amount === 'page') {
      pixels = window.innerHeight * 0.9;
    } else if (amount === 'half') {
      pixels = window.innerHeight * 0.45;
    } else {
      pixels = amount as number;
    }

    const scrollOpts: ScrollToOptions = { behavior: 'instant' };
    if (direction === 'down') scrollOpts.top = pixels;
    else if (direction === 'up') scrollOpts.top = -pixels;
    else if (direction === 'right') scrollOpts.left = pixels;
    else if (direction === 'left') scrollOpts.left = -pixels;

    if (target instanceof Window) {
      target.scrollBy(scrollOpts);
    } else {
      (target as HTMLElement).scrollBy(scrollOpts);
    }

    await this.settle();
    return captureSnapshot();
  }

  private pressKey(params: Record<string, unknown>): { success: boolean } {
    const key = params.key as string;
    const modifiers = (params.modifiers as string[] | undefined) ?? [];

    const opts: KeyboardEventInit = {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      ctrlKey: modifiers.includes('Ctrl'),
      shiftKey: modifiers.includes('Shift'),
      altKey: modifiers.includes('Alt'),
      metaKey: modifiers.includes('Meta'),
    };

    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
    return { success: true };
  }

  private drag(params: Record<string, unknown>): { success: boolean } {
    const from = this.getEl(params.fromRef as number) as HTMLElement;
    const to = this.getEl(params.toRef as number) as HTMLElement;

    const fromRect = from.getBoundingClientRect();
    const toRect = to.getBoundingClientRect();

    from.dispatchEvent(new DragEvent('dragstart', {
      bubbles: true,
      clientX: fromRect.x + fromRect.width / 2,
      clientY: fromRect.y + fromRect.height / 2,
    }));

    to.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      clientX: toRect.x + toRect.width / 2,
      clientY: toRect.y + toRect.height / 2,
    }));

    to.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      clientX: toRect.x + toRect.width / 2,
      clientY: toRect.y + toRect.height / 2,
    }));

    from.dispatchEvent(new DragEvent('dragend', { bubbles: true }));

    return { success: true };
  }

  private evaluate(params: Record<string, unknown>): { result: unknown } {
    const script = params.script as string;
    const ref = params.ref as number | undefined;

    let result: unknown;
    if (ref != null) {
      const element = this.getEl(ref);
      const fn = new Function('element', script);
      result = fn(element);
    } else {
      const fn = new Function(script);
      result = fn();
    }

    return { result };
  }

  private async wait(params: Record<string, unknown>): Promise<{ success: boolean; elapsed: number }> {
    const timeout = (params.timeout as number) ?? 10_000;
    const start = Date.now();
    const interval = 200;

    return new Promise((resolve, reject) => {
      const check = () => {
        const elapsed = Date.now() - start;

        if (params.text) {
          if (document.body.textContent?.includes(params.text as string)) {
            resolve({ success: true, elapsed });
            return;
          }
        }

        if (params.textGone) {
          if (!document.body.textContent?.includes(params.textGone as string)) {
            resolve({ success: true, elapsed });
            return;
          }
        }

        if (params.selector) {
          if (document.querySelector(params.selector as string)) {
            resolve({ success: true, elapsed });
            return;
          }
        }

        if (elapsed >= timeout) {
          reject(new Error(`Wait timed out after ${timeout}ms`));
          return;
        }

        setTimeout(check, interval);
      };

      check();
    });
  }

  private screenshot(): { base64: string } {
    throw new Error('Screenshot must be handled by background script');
  }

  private getEl(ref: number): Element {
    const el = getElementByRef(ref);
    if (!el) throw new Error(`Element ref ${ref} not found. Page may have changed — try running snapshot first.`);
    return el;
  }

  private settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 150));
  }
}
