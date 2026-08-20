/**
 * Chrome DevTools Protocol session manager.
 *
 * Everything the agent does to a page used to be a synthetic DOM event
 * (`el.dispatchEvent(new MouseEvent(...))`), which arrives with `isTrusted:
 * false`. Native form submission, drag-and-drop, canvas apps and every anti-bot
 * check reject those. CDP's Input domain produces real, trusted input.
 *
 * Attachment is deliberately sticky: Chrome shows an "onbridge started debugging
 * this browser" infobar for as long as we are attached, and re-attaching per
 * command would make it flicker constantly. Staying attached while control mode
 * is on keeps it stable — and that banner is honest, unspoofable transparency
 * that something is driving the browser, so it is a feature, not a cost.
 */

const CDP_VERSION = '1.3';

/** Attach failures are expected and routine, not exceptional. */
export class CdpUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CdpUnavailable';
  }
}

const attached = new Set<number>();
/** Tabs where attach failed; retrying every command would be pointless churn. */
const refused = new Map<number, string>();

/**
 * A main-world execution context, and the CDP session that owns it.
 *
 * `Runtime.evaluate` without a `contextId` only ever reaches the top frame, which
 * is why anything inside an iframe used to be unreachable by trusted input: the
 * ref was visible in the snapshot but the main world could not resolve it.
 *
 * Cross-origin iframes need the session as well as the context. They run in
 * their own process, and the tab-level session simply does not report them —
 * only `Target.setAutoAttach` surfaces them, as a child session with its own
 * context ids. Context ids are unique per session, not per tab, so a context is
 * only addressable as the pair.
 *
 * Only default (main-world) contexts are kept. Isolated worlds — including our
 * own content script's — share the DOM but not page globals, which is precisely
 * what `evaluate` must not run in.
 */
export interface World {
  contextId: number;
  /** Absent for frames sharing the top frame's process. */
  sessionId?: string;
}

const worldsByTab = new Map<number, Map<string, World>>();

const worldKey = (w: World) => `${w.sessionId ?? ''}:${w.contextId}`;

export function mainWorlds(tabId: number): World[] {
  return [...(worldsByTab.get(tabId)?.values() ?? [])];
}

export function hasWorld(tabId: number, world: World): boolean {
  return worldsByTab.get(tabId)?.has(worldKey(world)) ?? false;
}

function addWorld(tabId: number, world: World): void {
  const map = worldsByTab.get(tabId) ?? new Map<string, World>();
  map.set(worldKey(world), world);
  worldsByTab.set(tabId, map);
}

function dropSession(tabId: number, sessionId: string): void {
  const map = worldsByTab.get(tabId);
  if (!map) return;
  for (const [key, w] of map) if (w.sessionId === sessionId) map.delete(key);
}

export function isAttached(tabId: number): boolean {
  return attached.has(tabId);
}

export async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;

  const priorFailure = refused.get(tabId);
  if (priorFailure) throw new CdpUnavailable(priorFailure);

  await new Promise<void>((resolve, reject) => {
    chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (!err) return resolve();

      // Most common causes: DevTools is already open on this tab (only one
      // debugger client is allowed), or it is a restricted chrome:// page.
      const reason = err.message ?? 'debugger attach failed';
      refused.set(tabId, reason);
      reject(new CdpUnavailable(reason));
    });
  });

  attached.add(tabId);

  // Runtime must be enabled for `executionContextCreated` to arrive, and it
  // replays the contexts that already exist — which is the normal case, since we
  // attach on the first command rather than at page load.
  await send(tabId, 'Runtime.enable').catch(() => {});
  await autoAttach(tabId);
}

/**
 * Surfaces out-of-process iframes as child sessions.
 *
 * Without this a cross-origin frame is invisible: it is missing from the tab
 * session's context list entirely, so its elements cannot be resolved at all.
 */
async function autoAttach(tabId: number, sessionId?: string): Promise<void> {
  await send(
    tabId,
    'Target.setAutoAttach',
    { autoAttach: true, flatten: true, waitForDebuggerOnStart: false },
    sessionId,
  ).catch(() => {});
}

export function detach(tabId: number): void {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  worldsByTab.delete(tabId);
  chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
}

export function detachAll(): void {
  for (const tabId of [...attached]) detach(tabId);
  refused.clear();
}

/** Lets a tab retry after the blocking condition (e.g. DevTools) has cleared. */
export function forgetRefusal(tabId: number): void {
  refused.delete(tabId);
}

export function send<T = any>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
): Promise<T> {
  // `sessionId` addresses a flattened child session (an out-of-process iframe).
  // @types/chrome has not caught up with it, hence the cast.
  const target = { tabId, ...(sessionId ? { sessionId } : {}) } as chrome.debugger.Debuggee;
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        // A detach can happen underneath us (tab closed, user dismissed the
        // banner). Drop the stale bookkeeping so the next call re-attaches.
        if (/detached|not attached|No tab with given id/i.test(err.message ?? '')) {
          attached.delete(tabId);
        }
        return reject(new Error(err.message ?? `${method} failed`));
      }
      resolve(result as T);
    });
  });
}

export interface ConsoleEntry {
  level: string;
  text: string;
  url?: string;
  timestamp: number;
}

/**
 * Console output, captured per tab.
 *
 * The old `console_logs` tool returned an array that nothing ever wrote to — it
 * always answered with an empty list. There is no extension API for reading a
 * page's console, so this needs CDP.
 */
const consoleByTab = new Map<number, ConsoleEntry[]>();
const CONSOLE_LIMIT = 200;

export function getConsole(tabId: number): ConsoleEntry[] {
  return consoleByTab.get(tabId) ?? [];
}

export function clearConsole(tabId: number): void {
  consoleByTab.delete(tabId);
}

function record(tabId: number, entry: ConsoleEntry): void {
  const list = consoleByTab.get(tabId) ?? [];
  list.push(entry);
  if (list.length > CONSOLE_LIMIT) list.splice(0, list.length - CONSOLE_LIMIT);
  consoleByTab.set(tabId, list);
}

/** Enables the domains that emit console and error events. */
export async function enableConsoleCapture(tabId: number): Promise<void> {
  // `attach` already enables Runtime; Log adds the browser-level warnings the
  // page itself never sees.
  await attach(tabId);
  await send(tabId, 'Log.enable').catch(() => {});
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  const p = params as any;

  const sessionId = (source as { sessionId?: string }).sessionId;

  if (method === 'Target.attachedToTarget') {
    const child = p.sessionId as string;
    // A newly surfaced frame reports nothing until Runtime is enabled on its own
    // session, and it may itself contain further out-of-process frames.
    void send(tabId, 'Runtime.enable', {}, child).catch(() => {});
    void autoAttach(tabId, child);
    return;
  }
  if (method === 'Target.detachedFromTarget') {
    dropSession(tabId, p.sessionId as string);
    return;
  }
  if (method === 'Runtime.executionContextCreated') {
    if (p.context?.auxData?.isDefault) addWorld(tabId, { contextId: p.context.id, sessionId });
    return;
  }
  if (method === 'Runtime.executionContextDestroyed') {
    worldsByTab.get(tabId)?.delete(`${sessionId ?? ''}:${p.executionContextId}`);
    return;
  }
  if (method === 'Runtime.executionContextsCleared') {
    // Sent on cross-document navigation: every ref and context is now stale.
    if (sessionId) dropSession(tabId, sessionId);
    else worldsByTab.delete(tabId);
    return;
  }

  if (method === 'Runtime.consoleAPICalled') {
    record(tabId, {
      level: p.type ?? 'log',
      text: (p.args ?? [])
        .map((a: any) => a.value ?? a.description ?? a.unserializableValue ?? '')
        .join(' ')
        .slice(0, 2000),
      timestamp: Date.now(),
    });
  } else if (method === 'Runtime.exceptionThrown') {
    const d = p.exceptionDetails ?? {};
    record(tabId, {
      level: 'error',
      text: (d.exception?.description ?? d.text ?? 'Uncaught exception').slice(0, 2000),
      url: d.url,
      timestamp: Date.now(),
    });
  } else if (method === 'Log.entryAdded') {
    // Network/security/deprecation warnings the page itself never sees.
    record(tabId, {
      level: p.entry?.level ?? 'info',
      text: (p.entry?.text ?? '').slice(0, 2000),
      url: p.entry?.url,
      timestamp: Date.now(),
    });
  }
});

// Chrome tears the session down on navigation-ish events; keep state honest.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId == null) return;
  attached.delete(source.tabId);
  worldsByTab.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  refused.delete(tabId);
  consoleByTab.delete(tabId);
  worldsByTab.delete(tabId);
});
