/**
 * Trusted input via CDP's Input domain.
 *
 * Element addressing reuses the `data-onbridge-ref` attribute that dom-capture
 * writes. That is a real DOM attribute, so the main world can see it — no
 * content-script round trip is needed to resolve a ref.
 */

import { attach, send, mainWorlds, hasWorld, type World } from './cdp.js';

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
 * Injected into the page to resolve a ref. A flat querySelector stops at shadow
 * boundaries, so anything inside a web component would be unreachable — the
 * element is visible in the snapshot but unclickable.
 */
function deepResolve(ref: number): string {
  return `
    (function findRef(root) {
      const hit = root.querySelector('[data-onbridge-ref="${ref}"]');
      if (hit) return hit;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const inner = findRef(el.shadowRoot);
          if (inner) return inner;
        }
      }
      return null;
    })(document)`;
}

/**
 * Finds the execution context belonging to a Chrome frame id.
 *
 * `Runtime.evaluate` with no `contextId` always lands in the top frame, which is
 * why iframe content was previously unreachable by trusted input. The snapshot
 * stamps `data-onbridge-frame` on each frame's documentElement, so matching that
 * marker identifies the right context — including for cross-origin frames, which
 * run in a different process and cannot be reached from the parent by any
 * same-page means.
 */
const worldCache = new Map<number, Map<number, World>>();

/**
 * Every CDP call for one action must go through the *same* session.
 *
 * A child session reports coordinates in its own frame's space, and interprets
 * dispatched input in that space too — so quads and input agree as long as
 * neither crosses a session boundary. Mixing them is what silently sends a click
 * to the wrong place: frame-local coordinates dispatched on the root session
 * land wherever that point happens to be in the top document.
 */
async function targetForFrame(tabId: number, frameId: number): Promise<World> {
  // The top frame's default context is what an omitted contextId already selects.
  if (!frameId) return {} as World;

  const cached = worldCache.get(tabId)?.get(frameId);
  if (cached && hasWorld(tabId, cached)) return cached;

  for (const world of mainWorlds(tabId)) {
    try {
      const { result } = await send(
        tabId,
        'Runtime.evaluate',
        {
          expression: `document.documentElement.getAttribute('data-onbridge-frame')`,
          contextId: world.contextId,
          returnByValue: true,
        },
        world.sessionId,
      );
      if (result?.value !== String(frameId)) continue;
      const byFrame = worldCache.get(tabId) ?? new Map<number, World>();
      byFrame.set(frameId, world);
      worldCache.set(tabId, byFrame);
      return world;
    } catch {
      // Contexts are torn down asynchronously; a stale one is not an error.
    }
  }

  throw new Error(
    `Frame ${frameId} is no longer reachable. It may have navigated or been removed — run snapshot again.`,
  );
}

/** Resolves a ref to a live CDP object handle inside its owning frame. */
async function resolveHandle(tabId: number, ref: number, world: World): Promise<string> {
  const { result } = await send(
    tabId,
    'Runtime.evaluate',
    {
      expression: deepResolve(ref),
      ...(world.contextId != null ? { contextId: world.contextId } : {}),
    },
    world.sessionId,
  );
  if (!result?.objectId) {
    throw new Error(
      `Element ref ${ref} not found. The page may have changed — run snapshot again.`,
    );
  }
  return result.objectId as string;
}

function release(tabId: number, objectId: string, world: World): void {
  void send(tabId, 'Runtime.releaseObject', { objectId }, world.sessionId).catch(() => {});
}

/**
 * Scrolls the element into view and returns its centre in **top-level viewport**
 * coordinates, which is the space `Input.dispatchMouseEvent` works in.
 *
 * `DOM.getContentQuads` does the frame-offset arithmetic itself, so an element
 * nested inside iframes needs no manual coordinate translation — and CDP's own
 * scrollIntoViewIfNeeded scrolls ancestor frames, which a page-level
 * `scrollIntoView` inside a cross-origin child cannot do.
 */
async function locate(
  tabId: number,
  ref: number,
  frameId: number,
): Promise<{ point: Point; world: World }> {
  const world = await targetForFrame(tabId, frameId);
  const objectId = await resolveHandle(tabId, ref, world);
  try {
    await send(tabId, 'DOM.scrollIntoViewIfNeeded', { objectId }, world.sessionId).catch(
      async () => {
        await send(
          tabId,
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration:
              "function(){ this.scrollIntoView({behavior:'instant',block:'center',inline:'center'}); }",
          },
          world.sessionId,
        ).catch(() => {});
      },
    );

    let quads: number[][] | undefined;
    try {
      ({ quads } = await send(tabId, 'DOM.getContentQuads', { objectId }, world.sessionId));
    } catch {
      quads = undefined;
    }
    if (!quads?.length) {
      throw new Error(
        `Element ref ${ref} has no layout — it may be hidden or collapsed. Run snapshot again to see the current page.`,
      );
    }
    const [x1, y1, , , x3, y3] = quads[0];
    return { point: { x: (x1 + x3) / 2, y: (y1 + y3) / 2 }, world };
  } finally {
    release(tabId, objectId, world);
  }
}

async function moveTo(tabId: number, p: Point, modifiers = 0, world: World = {} as World): Promise<void> {
  await send(
    tabId,
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: p.x, y: p.y, modifiers },
    world.sessionId,
  );
}

export async function click(
  tabId: number,
  ref: number,
  opts: { button?: string; doubleClick?: boolean; modifiers?: string[] } = {},
  frameId = 0,
): Promise<World> {
  await attach(tabId);
  const { point: p, world } = await locate(tabId, ref, frameId);
  const modifiers = modifierMask(opts.modifiers);
  const button = opts.button === 'right' ? 'right' : opts.button === 'middle' ? 'middle' : 'left';
  const clickCount = opts.doubleClick ? 2 : 1;

  // A real pointer moves before it presses; some menus and hover-driven UIs
  // only reveal their target once a mousemove has landed on them.
  await moveTo(tabId, p, modifiers, world);

  for (let i = 1; i <= clickCount; i++) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send(
        tabId,
        'Input.dispatchMouseEvent',
        { type, x: p.x, y: p.y, button, clickCount: i, modifiers },
        world.sessionId,
      );
    }
  }
  return world;
}

export async function hover(tabId: number, ref: number, frameId = 0): Promise<void> {
  await attach(tabId);
  const { point, world } = await locate(tabId, ref, frameId);
  await moveTo(tabId, point, 0, world);
}

export async function pressKey(
  tabId: number,
  key: string,
  modifiers: string[] = [],
  world: World = {} as World,
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

  await send(
    tabId,
    'Input.dispatchKeyEvent',
    { type: downType, modifiers: mask, ...base },
    world.sessionId,
  );
  await send(
    tabId,
    'Input.dispatchKeyEvent',
    { type: 'keyUp', modifiers: mask, ...base },
    world.sessionId,
  );
}

export async function typeText(
  tabId: number,
  ref: number,
  text: string,
  opts: { clear?: boolean; submit?: boolean } = {},
  frameId = 0,
): Promise<void> {
  await attach(tabId);

  // Focus by clicking, exactly as a user would: this fires the focus/blur
  // sequence frameworks listen for, which programmatic .focus() can skip.
  // The click also tells us which session owns the element, and every key event
  // that follows has to go to that same session — an out-of-process frame does
  // not receive input dispatched on the tab's root session.
  const world = await click(tabId, ref, {}, frameId);

  if (opts.clear) {
    const selectAll = {
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: navigator.userAgent.includes('Mac') ? MOD.Meta : MOD.Ctrl,
    };
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...selectAll }, world.sessionId);
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...selectAll }, world.sessionId);
    await pressKey(tabId, 'Delete', [], world);
  }

  // insertText delivers the whole string as one composition-style input, which
  // is what fixes React controlled inputs. The old path did `el.value += char`,
  // fighting React's reconciliation and ignoring cursor position entirely.
  if (text) await send(tabId, 'Input.insertText', { text }, world.sessionId);

  if (opts.submit) await pressKey(tabId, 'Enter', [], world);
}

export async function evaluate(
  tabId: number,
  script: string,
  ref?: number,
  frameId = 0,
): Promise<unknown> {
  await attach(tabId);
  const world = await targetForFrame(tabId, frameId);

  // Runs in the MAIN world. The old implementation used `new Function` inside
  // the content script's isolated world, so page globals — framework stores,
  // __NEXT_DATA__, anything the app defines — were invisible to it.
  const expression =
    ref != null
      ? `(function(){ const element = ${deepResolve(ref)}; return (function(){ ${script} }).call(element); })()`
      : `(function(){ ${script} })()`;

  const { result, exceptionDetails } = await send(
    tabId,
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...(world.contextId != null ? { contextId: world.contextId } : {}),
    },
    world.sessionId,
  );

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

export async function dragAndDrop(
  tabId: number,
  fromRef: number,
  toRef: number,
  frameId = 0,
): Promise<void> {
  await attach(tabId);
  const { point: from, world } = await locate(tabId, fromRef, frameId);
  const { point: to } = await locate(tabId, toRef, frameId);

  await moveTo(tabId, from, 0, world);
  await send(
    tabId,
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 },
    world.sessionId,
  );
  // Intermediate moves matter: HTML5 drag and most drag libraries only begin a
  // drag after movement, so a straight press-to-release does nothing.
  for (let i = 1; i <= 5; i++) {
    await moveTo(
      tabId,
      { x: from.x + ((to.x - from.x) * i) / 5, y: from.y + ((to.y - from.y) * i) / 5 },
      0,
      world,
    );
  }
  await send(
    tabId,
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 },
    world.sessionId,
  );
}
