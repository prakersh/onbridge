/**
 * Trusted input via CDP's Input domain.
 *
 * Element addressing reuses the `data-onbridge-ref` attribute that dom-capture
 * writes. That is a real DOM attribute, so the main world can see it — no
 * content-script round trip is needed to resolve a ref.
 */

import { attach, send } from './cdp.js';

/** CDP modifier bitmask. */
const MOD = { Alt: 1, Ctrl: 2, Control: 2, Meta: 4, Command: 4, Shift: 8 } as const;

/** Keys that need an explicit virtual key code to behave natively. */
const KEY_CODES: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
  ' ': { code: 'Space', vk: 32, text: ' ' },
};

function modifierMask(modifiers: string[] = []): number {
  return modifiers.reduce((m, name) => m | (MOD[name as keyof typeof MOD] ?? 0), 0);
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Scrolls the element into view and returns its viewport-centre coordinates.
 * Runs in the main world, so it sees the page exactly as the user's browser does.
 */
export async function centreOf(tabId: number, ref: number): Promise<Point> {
  const expression = `
    (() => {
      const el = document.querySelector('[data-onbridge-ref="${ref}"]');
      if (!el) return null;
      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()
  `;
  const { result } = await send(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  if (!result?.value) {
    throw new Error(
      `Element ref ${ref} not found or has no layout. The page may have changed — run snapshot again.`,
    );
  }
  return result.value as Point;
}

async function moveTo(tabId: number, p: Point, modifiers = 0): Promise<void> {
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: p.x,
    y: p.y,
    modifiers,
  });
}

export async function click(
  tabId: number,
  ref: number,
  opts: { button?: string; doubleClick?: boolean; modifiers?: string[] } = {},
): Promise<void> {
  await attach(tabId);
  const p = await centreOf(tabId, ref);
  const modifiers = modifierMask(opts.modifiers);
  const button = opts.button === 'right' ? 'right' : opts.button === 'middle' ? 'middle' : 'left';
  const clickCount = opts.doubleClick ? 2 : 1;

  // A real pointer moves before it presses; some menus and hover-driven UIs
  // only reveal their target once a mousemove has landed on them.
  await moveTo(tabId, p, modifiers);

  for (let i = 1; i <= clickCount; i++) {
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: p.x,
      y: p.y,
      button,
      clickCount: i,
      modifiers,
    });
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: p.x,
      y: p.y,
      button,
      clickCount: i,
      modifiers,
    });
  }
}

export async function hover(tabId: number, ref: number): Promise<void> {
  await attach(tabId);
  await moveTo(tabId, await centreOf(tabId, ref));
}

export async function pressKey(
  tabId: number,
  key: string,
  modifiers: string[] = [],
): Promise<void> {
  await attach(tabId);
  const mask = modifierMask(modifiers);
  const known = KEY_CODES[key];

  const base = known
    ? { key, code: known.code, windowsVirtualKeyCode: known.vk, text: known.text }
    : {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
        text: key.length === 1 ? key : undefined,
      };

  // With a modifier held, the browser produces no character, so rawKeyDown is
  // correct; a plain keypress should carry its text.
  const downType = mask && mask !== MOD.Shift ? 'rawKeyDown' : 'keyDown';

  await send(tabId, 'Input.dispatchKeyEvent', { type: downType, modifiers: mask, ...base });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mask, ...base });
}

export async function typeText(
  tabId: number,
  ref: number,
  text: string,
  opts: { clear?: boolean; submit?: boolean } = {},
): Promise<void> {
  await attach(tabId);

  // Focus by clicking, exactly as a user would: this fires the focus/blur
  // sequence frameworks listen for, which programmatic .focus() can skip.
  await click(tabId, ref);

  if (opts.clear) {
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: navigator.userAgent.includes('Mac') ? MOD.Meta : MOD.Ctrl,
    });
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: navigator.userAgent.includes('Mac') ? MOD.Meta : MOD.Ctrl,
    });
    await pressKey(tabId, 'Delete');
  }

  // insertText delivers the whole string as one composition-style input, which
  // is what fixes React controlled inputs. The old path did `el.value += char`,
  // fighting React's reconciliation and ignoring cursor position entirely.
  if (text) await send(tabId, 'Input.insertText', { text });

  if (opts.submit) await pressKey(tabId, 'Enter');
}

export async function evaluate(
  tabId: number,
  script: string,
  ref?: number,
): Promise<unknown> {
  await attach(tabId);

  // Runs in the MAIN world. The old implementation used `new Function` inside
  // the content script's isolated world, so page globals — framework stores,
  // __NEXT_DATA__, anything the app defines — were invisible to it.
  const expression =
    ref != null
      ? `(function(){ const element = document.querySelector('[data-onbridge-ref="${ref}"]'); return (function(){ ${script} }).call(element); })()`
      : `(function(){ ${script} })()`;

  const { result, exceptionDetails } = await send(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });

  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'evaluate failed');
  }
  return result?.value;
}

export async function screenshot(
  tabId: number,
  opts: { fullPage?: boolean; quality?: number } = {},
): Promise<string> {
  await attach(tabId);
  const { data } = await send(tabId, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality: opts.quality ?? 60,
    captureBeyondViewport: Boolean(opts.fullPage),
  });
  return data as string;
}

export async function dragAndDrop(tabId: number, fromRef: number, toRef: number): Promise<void> {
  await attach(tabId);
  const from = await centreOf(tabId, fromRef);
  const to = await centreOf(tabId, toRef);

  await moveTo(tabId, from);
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: from.x,
    y: from.y,
    button: 'left',
    clickCount: 1,
  });
  // Intermediate moves matter: HTML5 drag and most drag libraries only begin a
  // drag after movement, so a straight press-to-release does nothing.
  for (let i = 1; i <= 5; i++) {
    await moveTo(tabId, {
      x: from.x + ((to.x - from.x) * i) / 5,
      y: from.y + ((to.y - from.y) * i) / 5,
    });
  }
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: to.x,
    y: to.y,
    button: 'left',
    clickCount: 1,
  });
}
