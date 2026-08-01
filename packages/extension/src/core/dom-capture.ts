import type { DomNode, PageSnapshot, FindResult, ScrollState } from '@onbridge/shared';

const INTERACTIVE_TAGS = new Set([
  'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY',
]);

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'radio', 'checkbox', 'switch', 'slider', 'spinbutton',
  'textbox', 'combobox', 'searchbox', 'treeitem', 'gridcell',
]);

const TAG_TO_ROLE: Record<string, string> = {
  A: 'link',
  BUTTON: 'button',
  SELECT: 'combobox',
  TEXTAREA: 'textbox',
  NAV: 'nav',
  MAIN: 'main',
  HEADER: 'banner',
  FOOTER: 'contentinfo',
  FORM: 'form',
  TABLE: 'table',
  UL: 'list',
  OL: 'list',
  LI: 'listitem',
  IMG: 'img',
  SECTION: 'region',
  ARTICLE: 'article',
  ASIDE: 'complementary',
  DIALOG: 'dialog',
  HR: 'separator',
  H1: 'heading',
  H2: 'heading',
  H3: 'heading',
  H4: 'heading',
  H5: 'heading',
  H6: 'heading',
};

const INPUT_TYPE_TO_ROLE: Record<string, string> = {
  text: 'textbox',
  password: 'textbox',
  email: 'textbox',
  url: 'textbox',
  tel: 'textbox',
  number: 'spinbutton',
  search: 'search',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  file: 'file',
  submit: 'button',
  reset: 'button',
  button: 'button',
  hidden: 'hidden',
};

const FORCE_INTERACTIVE_ID = /add-to-cart|buy-now|submit|checkout|sign-in|login|search-btn/i;
const COMPACT_SKIP_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE']);
const COMPACT_SKIP_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary']);
const COMPACT_SKIP_CLASS = /sponsored|ad-slot|promo-|carousel|recommendation|sidebar|footer|header-nav|nav-bar|top-nav|bottom-nav/i;
const COMPACT_SKIP_IDS = /nav|header|footer|sidebar|banner|skip-link/i;
const TEXT_MAX_LENGTH = 80;
const ATTR = 'data-onbridge-ref';

let refCounter = 0;
let refMap = new Map<number, Element>();

function getRole(el: Element): string | null {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;

  const tag = el.tagName;

  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type || 'text';
    return INPUT_TYPE_TO_ROLE[type] ?? 'textbox';
  }

  return TAG_TO_ROLE[tag] ?? null;
}

function isInteractive(el: Element): boolean {
  if (INTERACTIVE_TAGS.has(el.tagName)) return true;

  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;

  if ((el as HTMLElement).isContentEditable) return true;
  if (el.getAttribute('tabindex') !== null) return true;
  if (el.getAttribute('onclick') !== null) return true;

  // Cursor pointer is a strong signal for clickable elements
  try {
    const style = window.getComputedStyle(el as HTMLElement);
    if (style.cursor === 'pointer') return true;
  } catch {}

  // Common SPA data attributes for click handlers
  if (el.getAttribute('data-action') !== null) return true;
  if (el.getAttribute('data-click') !== null) return true;
  if (el.getAttribute('jsaction') !== null) return true;

  // Elements inside label tags are clickable
  if (el.closest('label')) return true;

  return false;
}

function isVisible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (parseFloat(style.opacity) <= 0) return false;

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'hidden') return false;
    if (!el.children.length) return false;
  }

  return true;
}

function getAccessibleName(el: Element): string {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return truncate(ariaLabel);

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/).map((id) => {
      const target = document.getElementById(id);
      return target?.textContent?.trim() ?? '';
    });
    const joined = parts.filter(Boolean).join(' ');
    if (joined) return truncate(joined);
  }

  if (el.tagName === 'IMG') {
    const alt = el.getAttribute('alt');
    if (alt) return truncate(alt);
  }

  const title = el.getAttribute('title');
  if (title) return truncate(title);

  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const placeholder = (el as HTMLInputElement).placeholder;
    if (placeholder) return '';

    const id = el.id;
    if (id) {
      const label = document.querySelector(`label[for="${id}"]`);
      if (label?.textContent) return truncate(label.textContent.trim());
    }
  }

  const text = getDirectText(el);
  if (text) return truncate(text);

  return '';
}

function getDirectText(el: Element): string {
  let text = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
    }
  }
  return text.trim();
}

function truncate(str: string): string {
  const clean = str.replace(/\s+/g, ' ').trim();
  if (clean.length <= TEXT_MAX_LENGTH) return clean;
  return clean.slice(0, TEXT_MAX_LENGTH - 1) + '…';
}

function shouldInclude(el: Element, role: string | null): boolean {
  if (isInteractive(el)) return true;
  if (role && !['generic', 'presentation', 'none'].includes(role)) return true;

  const text = getDirectText(el);
  if (text.length > 0) return true;

  return false;
}

function buildNode(el: Element, maxDepth: number, currentDepth: number, compact = false): DomNode | null {
  if (!isVisible(el)) return null;
  if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') return null;

  if (compact) {
    const cls = el.className;
    if (typeof cls === 'string' && COMPACT_SKIP_CLASS.test(cls)) return null;
    // Skip by role (covers <div role="navigation"> etc.)
    const elRole = el.getAttribute('role');
    if (elRole && COMPACT_SKIP_ROLES.has(elRole)) return null;
    // Skip by tag
    if (COMPACT_SKIP_TAGS.has(el.tagName)) return null;
    // Skip by ID pattern
    if (el.id && COMPACT_SKIP_IDS.test(el.id)) return null;
  }

  const role = getRole(el);
  const interactive = isInteractive(el);

  // Force-detect interactive elements by meaningful ID
  const elId = el.id;
  const forceInteractive = !!(elId && FORCE_INTERACTIVE_ID.test(elId));
  const effectiveInteractive = interactive || forceInteractive;

  const name = getAccessibleName(el);

  const children: DomNode[] = [];
  if (currentDepth < maxDepth) {
    for (const child of el.children) {
      const childNode = buildNode(child, maxDepth, currentDepth + 1, compact);
      if (childNode) children.push(childNode);
    }
  }

  const directText = getDirectText(el);
  if (!effectiveInteractive && !role && children.length === 0 && !directText) {
    return null;
  }

  if (!effectiveInteractive && !role && children.length === 1 && !directText) {
    return children[0];
  }

  if (!shouldInclude(el, role) && !forceInteractive && children.length === 0) {
    return null;
  }

  const node: DomNode = {
    role: role ?? (directText ? 'text' : 'group'),
  };

  if (effectiveInteractive) {
    const existingRef = el.getAttribute(ATTR);
    if (existingRef) {
      const ref = parseInt(existingRef, 10);
      node.ref = ref;
      refMap.set(ref, el);
    } else {
      refCounter++;
      node.ref = refCounter;
      refMap.set(refCounter, el);
      el.setAttribute(ATTR, String(refCounter));
    }
  }

  if (name) node.name = name;

  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
    const val = (el as HTMLInputElement).value;
    if (val) node.value = truncate(val);
  }

  if (el.tagName === 'INPUT') {
    const input = el as HTMLInputElement;
    if (input.type === 'checkbox' || input.type === 'radio') {
      node.checked = input.checked;
    }
    if (input.placeholder) node.placeholder = input.placeholder;
    if (input.type && input.type !== 'text') node.type = input.type;
  }

  if ((el as HTMLInputElement).disabled) node.disabled = true;

  if (el.tagName === 'A') {
    const href = (el as HTMLAnchorElement).href;
    if (href && !href.startsWith('javascript:')) {
      try {
        const url = new URL(href);
        node.href = url.pathname.length > 50
          ? url.origin + url.pathname.slice(0, 47) + '…'
          : url.origin + url.pathname;
      } catch {
        node.href = truncate(href);
      }
    }
  }

  // Include meaningful element IDs (not auto-generated hashes)
  if (elId && elId.length < 40 && !/^[a-f0-9-]{20,}$/i.test(elId)) {
    (node as any).id = elId;
  }

  const expanded = el.getAttribute('aria-expanded');
  if (expanded !== null) node.expanded = expanded === 'true';

  if (el.getAttribute('aria-selected') === 'true') node.selected = true;

  if (role === 'heading') {
    const match = el.tagName.match(/^H(\d)$/);
    if (match) node.level = parseInt(match[1]);
  }

  if (!name && directText && !effectiveInteractive) {
    node.name = truncate(directText);
  }

  if (children.length > 0) node.children = children;

  return node;
}

function getScrollState(): ScrollState {
  const scrollTop = window.scrollY;
  const scrollHeight = document.documentElement.scrollHeight;
  const viewportHeight = window.innerHeight;
  const maxScroll = scrollHeight - viewportHeight;

  if (maxScroll <= 0) {
    return { percent: 100, pagesAbove: 0, pagesBelow: 0 };
  }

  const percent = Math.round((scrollTop / maxScroll) * 100);
  const pagesAbove = Math.floor(scrollTop / viewportHeight);
  const pagesBelow = Math.max(0, Math.ceil((maxScroll - scrollTop) / viewportHeight));

  return { percent, pagesAbove, pagesBelow };
}

export function captureSnapshot(targetRef?: number, maxDepth = 20, compact = false): PageSnapshot {
  // Reuse existing refs for elements still in DOM
  refMap = new Map();
  document.querySelectorAll(`[${ATTR}]`).forEach((el) => {
    const existing = parseInt(el.getAttribute(ATTR)!, 10);
    if (!isNaN(existing)) {
      refMap.set(existing, el);
      if (existing > refCounter) refCounter = existing;
    }
  });

  let root: Element = document.body;
  if (targetRef != null) {
    const existing = refMap.get(targetRef);
    if (existing) root = existing;
  }

  const tree: DomNode[] = [];
  for (const child of root.children) {
    if (compact) {
      if (COMPACT_SKIP_TAGS.has(child.tagName)) continue;
      const childRole = child.getAttribute('role');
      if (childRole && COMPACT_SKIP_ROLES.has(childRole)) continue;
      if (child.id && COMPACT_SKIP_IDS.test(child.id)) continue;
      const cls = child.className;
      if (typeof cls === 'string' && COMPACT_SKIP_CLASS.test(cls)) continue;
    }
    const node = buildNode(child, maxDepth, 0, compact);
    if (node) tree.push(node);
  }

  return {
    url: window.location.href,
    title: document.title,
    tree,
    scroll: getScrollState(),
    refCount: refCounter,
  };
}

export function findElements(query: string, role?: string): FindResult[] {
  if (refMap.size === 0) {
    captureSnapshot();
  }

  const results: FindResult[] = [];
  const lowerQuery = String(query ?? '').toLowerCase();

  for (const [ref, el] of refMap) {
    const elRole = getRole(el) ?? 'generic';

    if (role && elRole !== role) continue;

    const name = getAccessibleName(el);
    const text = (el.textContent ?? '').toLowerCase();
    const value = ((el as HTMLInputElement).value ?? '').toLowerCase();
    const placeholder = ((el as HTMLInputElement).placeholder ?? '').toLowerCase();

    const matches = name.toLowerCase().includes(lowerQuery) ||
      text.includes(lowerQuery) ||
      value.includes(lowerQuery) ||
      placeholder.includes(lowerQuery);

    if (!matches) continue;

    let context = '';
    const parent = el.parentElement;
    if (parent) {
      const parentRole = getRole(parent);
      const parentName = getAccessibleName(parent);
      if (parentRole || parentName) {
        context = `in ${parentRole ?? 'group'}${parentName ? ` "${parentName}"` : ''}`;
      }
    }

    results.push({ ref, role: elRole, name: name || truncate(el.textContent?.trim() ?? ''), context });
  }

  return results;
}

export function getRefMap(): Map<number, Element> {
  return refMap;
}

export function getElementByRef(ref: number): Element | undefined {
  return refMap.get(ref);
}
