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
}

export function detach(tabId: number): void {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
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
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
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
  await attach(tabId);
  await Promise.all([
    send(tabId, 'Runtime.enable').catch(() => {}),
    send(tabId, 'Log.enable').catch(() => {}),
  ]);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  const p = params as any;

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
  if (source.tabId != null) attached.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  refused.delete(tabId);
  consoleByTab.delete(tabId);
});
