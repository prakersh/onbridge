import { defineBackground } from 'wxt/utils/define-background';
import type {
  ServerMessage,
  ExtensionMessage,
  DomNode,
  PageSnapshot,
  AgentIdentity,
} from '@onbridge/shared';
import { clearPairings } from '../core/secure-client.js';
import {
  ConnectionManager,
  scopeAllows,
  describeScope,
  type AgentSession,
  type SessionScope,
} from '../core/connection-manager.js';
import {
  CdpUnavailable,
  detachAll,
  forgetRefusal,
  getConsole,
  clearConsole,
  enableConsoleCapture,
} from '../core/cdp.js';
import * as trusted from '../core/trusted-input.js';
import {
  classify,
  evaluatePolicy,
  destinationUrls,
  firstDomainDenial,
  originOf,
  DEFAULT_POLICY,
  YOLO_TIMEOUT_MINUTES,
  type ApprovalMode,
  type Policy,
  type RiskClass,
} from '../core/policy.js';

/**
 * A pairing prompt is only honoured shortly after the user enables control mode.
 * Outside that window a local process cannot make us nag the user.
 */
const PAIR_WINDOW_MS = 60_000;
/** How long the Allow/Deny prompt stays open before defaulting to deny. */
const PAIR_PROMPT_TTL_MS = 60_000;
/** Slightly under the server's ask_user timeout so we resolve first, cleanly. */
const ASK_TTL_MS = 105_000;
/** Under the 30s command timeout, so an unanswered approval denies rather than
 *  leaving the agent staring at an opaque timeout. */
const APPROVAL_TTL_MS = 25_000;

export default defineBackground(() => {
  let controlMode = false;

  /** Set when the user flips control mode on — gates the pairing prompt. */
  let controlEnabledAt = 0;
  /**
   * A pairing prompt suppressed by the anti-nuisance window.
   *
   * Refusing silently is right for a background process trying to nag, and wrong
   * for the case that actually happens: the user starts a second agent an hour
   * into a session, and it never connects with no reason given anywhere. Keeping
   * the last refusal lets the panel say so and offer a deliberate way in.
   */
  let pairBlocked: { name: string; port: number; at: number } | null = null;
  let pairRequest:
    | {
        agent: AgentIdentity;
        port: number;
        resolve: (ok: boolean) => void;
        timer: ReturnType<typeof setTimeout>;
        /** This server forgot a pairing we still hold — see `onPairRequest`. */
        wasPaired: boolean;
      }
    | null = null;

  /** The agent is blocked on this until the user answers in the side panel. */
  let askRequest:
    | {
        question: string;
        options?: string[];
        resolve: (answer: string | null) => void;
        timer: ReturnType<typeof setTimeout>;
        askedAt: number;
      }
    | null = null;

  /** User-initiated pause. Commands are refused while set, but stay connected. */
  let paused = false;

  /**
   * Set when CDP could not attach and we fell back to synthetic events. Surfaced
   * in the panel and via bridge_status, because the fallback silently fails on
   * sites that check isTrusted — the user deserves to know why.
   */
  let degraded = '';

  let policy: Policy = { ...DEFAULT_POLICY };
  let lastCommandAt = Date.now();
  /** When bypass mode reverts to `auto` on its own. 0 when not in bypass. */
  let yoloExpiresAt = 0;
  let yoloTimer: ReturnType<typeof setTimeout> | null = null;

  /** The agent is blocked on this until the user allows or denies. */
  let approvalRequest:
    | {
        action: string;
        risk: RiskClass;
        reason: string;
        detail: string;
        url: string;
        resolve: (ok: boolean) => void;
        timer: ReturnType<typeof setTimeout>;
        askedAt: number;
      }
    | null = null;

  /**
   * What the user picks in the panel before handing an agent control. It is
   * resolved against the window the panel is open in, which is what makes
   * "control this window" mean the window the user is looking at.
   */
  type ScopeKind = 'tab' | 'window' | 'all';
  let preferredScope: ScopeKind = 'window';

  chrome.storage.local.get(['controlMode', 'preferredScope', 'policy'], (result) => {
    if (result.preferredScope) preferredScope = result.preferredScope as ScopeKind;
    if (result.policy) {
      policy = { ...DEFAULT_POLICY, ...(result.policy as Policy) };
      // yolo never survives a restart. Leaving prompts disabled across sessions
      // because of a choice made days ago is exactly how people get surprised.
      if (policy.mode === 'yolo') policy.mode = 'auto';
    }
    if (result.controlMode) {
      controlMode = true;
      controlEnabledAt = Date.now();
      manager.start();
    }
  });

  /** Builds a concrete grant from the user's preference and a given window. */
  async function buildScope(kind: ScopeKind, windowId?: number): Promise<SessionScope> {
    if (kind === 'all') return { kind: 'all' };
    const [tab] = windowId
      ? await chrome.tabs.query({ active: true, windowId })
      : await chrome.tabs.query({ active: true, currentWindow: true });
    if (kind === 'window') return { kind: 'window', windowId: windowId ?? tab?.windowId };
    return { kind: 'tab', tabId: tab?.id, windowId: windowId ?? tab?.windowId };
  }

  /**
   * Refuses a tab outside the session's grant.
   *
   * This is the isolation boundary between concurrent agents: an agent given one
   * window cannot reach into another, no matter what tab id it asks for.
   */
  async function enforceScope(session: AgentSession, tabId: number): Promise<void> {
    const scope = session.scope;
    if (!scope) {
      throw new Error(
        'This agent has not been given control of anything yet. Ask the user to press ' +
          '"Give this agent control" in the onbridge side panel.',
      );
    }
    if (scope.kind === 'all') return;

    let windowId: number | undefined;
    try {
      windowId = (await chrome.tabs.get(tabId)).windowId;
    } catch {
      throw new Error(`Tab ${tabId} no longer exists.`);
    }

    if (!scopeAllows(scope, tabId, windowId!)) {
      throw refusal(
        `Access denied: this agent controls ${describeScope(scope)} and tab ${tabId} is ` +
          'outside it. Another agent may be driving that window.',
      );
    }
  }

  /** The tab a scoped command defaults to when the agent names none. */
  async function defaultTabFor(session: AgentSession): Promise<number | undefined> {
    const scope = session.scope;
    if (!scope) return undefined;
    if (scope.kind === 'tab') return scope.tabId;

    // For a window grant, the active tab *of that window* — not of whatever
    // window Chrome last focused, which is what `currentWindow` would give and
    // is wrong the moment two agents drive two windows.
    if (scope.kind === 'window' && scope.windowId != null) {
      const [tab] = await chrome.tabs.query({ active: true, windowId: scope.windowId });
      return tab?.id;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
  }

  function summarizeParams(action: string, params: Record<string, unknown>): string {
    switch (action) {
      case 'navigate': return `→ ${(params.url as string ?? '').slice(0, 50)}`;
      case 'click': return `ref:${params.ref}`;
      case 'click_by_text': return `"${(params.text as string ?? '').slice(0, 30)}"`;
      case 'type': return `ref:${params.ref} "${(params.text as string ?? '').slice(0, 20)}"`;
      case 'fill_form': return `${(params.fields as unknown[])?.length ?? 0} fields`;
      case 'scroll': return `${params.direction}${params.ref ? ` ref:${params.ref}` : ''}`;
      case 'find': return `"${(params.text as string ?? params.selector as string ?? '').slice(0, 30)}"`;
      case 'dom_query': return `${(params.selector as string ?? '').slice(0, 30)}`;
      case 'dismiss_modal': return params.text ? `"${(params.text as string).slice(0, 20)}"` : 'auto';
      case 'press_key': return `${params.modifiers ? (params.modifiers as string[]).join('+') + '+' : ''}${params.key}`;
      case 'snapshot': return params.compact ? 'compact' : '';
      case 'download_file': return params.url ? (params.url as string).slice(0, 40) : `ref:${params.ref}`;
      default: return '';
    }
  }

  /**
   * Surfaces the Allow/Deny prompt. Resolves false unless the user actively
   * allows — an unanswered prompt is a denial, never a default-yes.
   */
  function requestPairing(
    agent: AgentIdentity,
    port: number,
    opts: { wasPaired: boolean } = { wasPaired: false },
  ): Promise<boolean> {
    if (Date.now() - controlEnabledAt > PAIR_WINDOW_MS) {
      pairBlocked = { name: agent.name, port, at: Date.now() };
      updateBadge('pair');
      return Promise.resolve(false);
    }
    if (pairRequest) pairRequest.resolve(false);

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (pairRequest?.resolve === resolve) pairRequest = null;
        resolve(false);
      }, PAIR_PROMPT_TTL_MS);

      pairRequest = { agent, port, resolve, timer, wasPaired: opts.wasPaired };
      updateBadge('pair');
    });
  }

  function resolvePairing(allow: boolean): void {
    if (!pairRequest) return;
    clearTimeout(pairRequest.timer);
    const { resolve } = pairRequest;
    pairRequest = null;
    resolve(allow);
  }

  /**
   * Tabs Chrome opened recently, so a command can be asked what it spawned.
   *
   * `window.open`, `target="_blank"` and a middle-click all put the new page in
   * a *different* tab, which the navigation guard would otherwise never look at:
   * the tab it was watching never moved. Bounded because this is appended to for
   * the life of the service worker.
   */
  const recentlyOpenedTabs: Array<{ tabId: number; at: number }> = [];

  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.id == null) return;
    recentlyOpenedTabs.push({ tabId: tab.id, at: Date.now() });
    if (recentlyOpenedTabs.length > 50) recentlyOpenedTabs.splice(0, recentlyOpenedTabs.length - 50);
  });

  /**
   * Navigations the browser has *started*, whether or not they have committed.
   *
   * Reading the tab's URL after a command only sees navigations that already
   * landed. `location.href = …` returns before anything commits, so a poll right
   * after it still reports the old page and the guard waves it through — the
   * blocked site then loads a moment later, unwatched. Recording intent as it is
   * announced removes the race instead of trying to out-wait it.
   */
  const recentNavigations: Array<{ tabId: number; url: string; at: number }> = [];

  chrome.webNavigation.onBeforeNavigate.addListener((d) => {
    if (d.frameId !== 0) return; // sub-frame loads are not the tab moving
    recentNavigations.push({ tabId: d.tabId, url: d.url, at: Date.now() });
    if (recentNavigations.length > 100) recentNavigations.splice(0, recentNavigations.length - 100);
  });

  /**
   * A refusal onbridge composed, as opposed to a failure carrying page text.
   *
   * The distinction is marked at the throw site and carried on the wire, because
   * the alternative — recognising our own wording downstream — lets a page throw
   * `new Error("Blocked by user policy: ...")` and be believed.
   */
  class TrustedError extends Error {}

  const refusal = (msg: string): TrustedError => new TrustedError(msg);

  const manager = new ConnectionManager({
    onPairRequest: requestPairing,
    onCommand: (session, msg) => void onServerMessage(session, msg),
    onChange: () => {
      updateBadge(manager.hasActive() ? 'on' : controlMode ? 'off' : 'disabled');
    },
    log: (m) => console.debug('[onbridge]', m),
  });

  async function onServerMessage(session: AgentSession, msg: ServerMessage): Promise<void> {
    if (msg.type === 'ping') {
      await manager.send(session.id, { type: 'pong' });
      return;
    }
    if (msg.type !== 'command') return;

    updateBadge('active');
    session.lastAction = msg.action;
    session.commandCount++;
    const cmdStart = Date.now();
    const summary = summarizeParams(msg.action, msg.params);

    let response: ExtensionMessage;
    try {
      const data = await handleCommand(session, msg);
      const timing = Date.now() - cmdStart;
      response = { type: 'result', id: msg.id, success: true, data, timing };
      session.activityLog.unshift({
        action: msg.action,
        summary,
        success: true,
        timing,
        timestamp: Date.now(),
      });
    } catch (err) {
      const timing = Date.now() - cmdStart;
      const errorMsg = err instanceof Error ? err.message : String(err);
      response = {
        type: 'result',
        id: msg.id,
        success: false,
        data: null,
        error: errorMsg,
        // Anything not deliberately marked is assumed to carry page text.
        ...(err instanceof TrustedError ? { errorKind: 'trusted' as const } : {}),
        timing,
      };
      session.activityLog.unshift({
        action: msg.action,
        summary,
        success: false,
        error: errorMsg,
        timing,
        timestamp: Date.now(),
      });
    }

    await manager.send(session.id, response);
    if (session.activityLog.length > 50) session.activityLog.length = 50;
    updateBadge('on');
  }

  function disconnect() {
    resolvePairing(false);
    resolveAsk(null); // never leave the agent blocked on a dead channel
    manager.stop();
    // Release the debugger so Chrome drops the "onbridge is debugging this
    // browser" banner the moment control mode ends.
    detachAll();
    degraded = '';
    updateBadge('disabled');
  }

  /**
   * Poses a question in the side panel and blocks the agent until answered.
   * Resolves null on timeout so the agent gets a retryable "no answer yet"
   * rather than a hard failure.
   */
  function askUser(question: string, options?: string[]): Promise<string | null> {
    if (askRequest) {
      askRequest.resolve(null);
      clearTimeout(askRequest.timer);
    }
    void openPanelHint();

    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        if (askRequest?.resolve === resolve) askRequest = null;
        updateBadge('on');
        resolve(null);
      }, ASK_TTL_MS);

      askRequest = { question, options, resolve, timer, askedAt: Date.now() };
      updateBadge('ask');
    });
  }

  function resolveAsk(answer: string | null): void {
    if (!askRequest) return;
    clearTimeout(askRequest.timer);
    const { resolve } = askRequest;
    askRequest = null;
    updateBadge('on');
    resolve(answer);
  }

  /**
   * chrome.sidePanel.open() requires a user gesture, so the agent cannot force
   * the panel open. Fall back to a notification the user can click.
   */
  async function openPanelHint(): Promise<void> {
    try {
      await chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon.svg'),
        title: 'onbridge — the agent needs you',
        message: 'Open the onbridge side panel to answer.',
        priority: 2,
      });
    } catch {
      // Notifications may be blocked; the badge still signals it.
    }
  }

  async function handleCommand(
    session: AgentSession,
    msg: ServerMessage & { type: 'command' },
  ): Promise<unknown> {
    const { action, params: rawParams } = msg;
    let params = rawParams;

    // ask_user and bridge_status are meta-commands: they must work even while
    // automation is paused, since answering is exactly how a user unblocks it.
    if (action === 'ask_user') {
      const answer = await askUser(params.question as string, params.options as string[] | undefined);
      return answer == null ? { timedOut: true } : { answer };
    }

    if (action === 'bridge_status') {
      const peers = manager
        .list()
        .filter((s) => s.id !== session.id)
        .map((s) => `${s.identity?.name ?? 'agent'} on :${s.port} (${s.status})`);
      return {
        accessScope: session.scope ? describeScope(session.scope) : 'nothing yet',
        scopeKind: session.scope?.kind ?? null,
        sessionStatus: session.status,
        agent: session.identity?.name,
        paused,
        commandCount: session.commandCount,
        controlMode,
        approvalMode: policy.mode,
        allowlist: policy.allowlist,
        denylist: policy.denylist,
        degraded: degraded || undefined,
        otherAgents: peers,
      };
    }

    if (paused) {
      throw refusal(
        'Automation is paused by the user in the onbridge side panel. Ask them to resume before retrying.',
      );
    }

    lastCommandAt = Date.now();

    // Resolve the target tab once, against *this session's* grant, and use it
    // for everything downstream. Letting each handler fall back to Chrome's
    // "current window" independently is wrong as soon as two agents drive two
    // windows — whichever window was focused last would win.
    const tabId = msg.tabId ?? (await defaultTabFor(session));
    if (tabId != null) await enforceScope(session, tabId);
    await enforcePolicy(action, params, tabId);

    // Translate global refs down to per-frame refs before dispatch. Everything
    // below this point works in the target frame's own ref space.
    const targetTabId = tabId;
    let frameId = 0;
    if (targetTabId) {
      const localised = localiseRefs(params, targetTabId);
      params = localised.params;
      frameId = localised.frameId;
    }

    // Where the tab sat before this command ran.
    //
    // Checking the destination the agent *named* covers `navigate` and friends,
    // and misses the commonest ways a browser actually moves: clicking a link,
    // pressing Enter in a form, `evaluate` assigning `location`. The domain
    // lists have to hold however the browser got somewhere, so the outcome is
    // checked too — see `guardNavigationOutcome`.
    const urlBefore = targetTabId
      ? ((await chrome.tabs.get(targetTabId).catch(() => null))?.url ?? '')
      : '';
    const startedAt = Date.now();

    try {
      return await dispatchCommand(session, action, params, tabId, frameId);
    } finally {
      // Deliberately in `finally`: an action that navigated somewhere blocked
      // and then failed for its own reasons still left the browser there, and a
      // refusal is the more important of the two outcomes to report.
      await guardNavigationOutcome(targetTabId, urlBefore, action, startedAt);
    }
  }

  /**
   * Refuses to hand back anything from a page the user blocked, however the
   * browser came to be on it, and puts the tab back where it was.
   *
   * Reverting the agent's own navigation is the point: leaving the tab parked on
   * a blocked page means every later command there is refused too, so the agent
   * is stuck somewhere it was never allowed to be.
   */
  async function guardNavigationOutcome(
    tabId: number | undefined,
    urlBefore: string,
    action: string,
    startedAt: number,
  ): Promise<void> {
    // A page that opened somewhere blocked in a new tab is just as much a way
    // past the domain lists as navigating this one, and leaves the blocked page
    // sitting there afterwards. Checked first, because it is the case that
    // leaves state behind.
    await guardOpenedTabs(action, startedAt);

    if (!tabId) return;

    // `evaluate` and `press_key` can start a navigation and return before the
    // browser has announced it — assigning `location`, or Enter submitting a
    // form. Clicks already wait inside their own handler. Give those two a short
    // window to declare themselves, exiting the moment one does, so the common
    // case where nothing navigates costs almost nothing.
    if (action === 'evaluate' || action === 'press_key') {
      for (let i = 0; i < 8; i++) {
        if (recentNavigations.some((n) => n.tabId === tabId && n.at >= startedAt)) break;
        await new Promise((r) => setTimeout(r, 40));
      }
    }

    // Where the tab went or is going: the committed URL, plus anything this
    // command announced but has not finished loading.
    const urlAfter = (await chrome.tabs.get(tabId).catch(() => null))?.url ?? '';
    const started = recentNavigations
      .filter((n) => n.tabId === tabId && n.at >= startedAt)
      .map((n) => n.url);

    const candidates = [...started, urlAfter].filter(
      (u) => u && originOf(u) !== originOf(urlBefore),
    );
    if (candidates.length === 0) return;

    const denial = firstDomainDenial(policy, candidates, 'navigate', action);
    if (!denial) return;

    await chrome.tabs.goBack(tabId).catch(() => {
      /* no history to go back to; the refusal below still stands */
    });

    throw refusal(
      `Blocked by user policy: ${denial} Running "${action}" moved the page there, ` +
        'so nothing from it is being returned and the tab has been sent back. ' +
        'Do not try to reach that site another way.',
    );
  }

  /** Closes any tab this command opened onto a blocked site, and refuses. */
  async function guardOpenedTabs(action: string, startedAt: number): Promise<void> {
    const opened = recentlyOpenedTabs.filter((t) => t.at >= startedAt);
    if (opened.length === 0) return;

    for (const { tabId } of opened) {
      // A brand new tab is about:blank for a moment; `pendingUrl` names where it
      // is going before the load commits, which is what we want to judge.
      let target = '';
      for (let i = 0; i < 6 && !target; i++) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) break;
        target = tab.pendingUrl || (tab.url && tab.url !== 'about:blank' ? tab.url : '');
        if (!target) await new Promise((r) => setTimeout(r, 80));
      }
      if (!target) continue;

      const denial = firstDomainDenial(policy, [target], 'navigate', action);
      if (!denial) continue;

      await chrome.tabs.remove(tabId).catch(() => {});
      throw refusal(
        `Blocked by user policy: ${denial} Running "${action}" opened it in a new tab, ` +
          'which has been closed. Nothing from that page is being returned.',
      );
    }
  }

  async function dispatchCommand(
    session: AgentSession,
    action: string,
    params: Record<string, unknown>,
    tabId: number | undefined,
    frameId: number,
  ): Promise<unknown> {
    switch (action) {
      case 'snapshot':
        return handleSnapshot(params, tabId);
      case 'navigate':
        return handleNavigate(params as { url: string }, tabId);
      case 'back':
        return handleGoBack(tabId);
      case 'forward':
        return handleGoForward(tabId);
      case 'reload':
        return handleReload(params as { hard?: boolean }, tabId);
      case 'list_tabs':
        return handleListTabs(session);
      case 'switch_tab':
        return handleSwitchTab(session, params as { tabId: number });
      case 'new_tab':
        return handleNewTab(session, params as { url?: string });
      case 'close_tab':
        return handleCloseTab(session, params as { tabId?: number }, tabId);
      case 'screenshot':
        return handleScreenshot(params as { fullPage?: boolean; quality?: number }, tabId);
      case 'get_cookies':
        return handleGetCookies(params as { domain?: string }, tabId);
      case 'set_cookie':
        return handleSetCookie(params as { name: string; value: string; domain: string });
      case 'console_logs':
        return handleConsoleLogs(params as { level?: string; clear?: boolean }, tabId);
      case 'download_file':
        return handleDownloadFile(params as { url?: string; ref?: number });
      case 'list_downloads':
        return handleListDownloads(params as { limit?: number });
      case 'activity_log':
        // This session's own history only. One agent reading another's actions
        // would leak what a different project is doing into its context.
        return { entries: session.activityLog.slice(0, 30), totalCommands: session.commandCount };
      case 'upload':
        return handleFileUpload(params as { ref: number; filePath: string }, tabId);
      case 'click':
      case 'click_by_text':
        return handleClickWithNavDetection(action, params, tabId, frameId);
      case 'type':
      case 'hover':
      case 'press_key':
      case 'drag':
      case 'evaluate':
        return handleTrustedAction(action, params, tabId, frameId);
      default:
        return routeToContentScript(action, params, tabId, frameId);
    }
  }

  /**
   * Refs are per-frame, so two frames would both hand out ref 1. The background
   * therefore issues globally unique refs and remembers which frame each one
   * belongs to, translating on the way back in.
   */
  interface FrameRef {
    frameId: number;
    localRef: number;
  }
  const frameRefsByTab = new Map<number, Map<number, FrameRef>>();
  let globalRefCounter = 0;

  function resolveRef(tabId: number, ref: number): FrameRef {
    return frameRefsByTab.get(tabId)?.get(ref) ?? { frameId: 0, localRef: ref };
  }

  /**
   * Rewrites every ref in a command's params from the global namespace to the
   * owning frame's, and reports which frame the command must be delivered to.
   */
  function localiseRefs(
    params: Record<string, unknown>,
    tabId: number,
  ): { params: Record<string, unknown>; frameId: number } {
    const out = { ...params };
    const frames = new Set<number>();

    for (const key of ['ref', 'fromRef', 'toRef', 'target'] as const) {
      const val = out[key];
      if (typeof val !== 'number') continue;
      const { frameId, localRef } = resolveRef(tabId, val);
      out[key] = localRef;
      frames.add(frameId);
    }

    if (Array.isArray(out.fields)) {
      out.fields = (out.fields as Array<{ ref: number; value: string }>).map((f) => {
        const { frameId, localRef } = resolveRef(tabId, f.ref);
        frames.add(frameId);
        return { ...f, ref: localRef };
      });
    }

    if (frames.size > 1) {
      throw new Error(
        'That command spans elements in different frames, which cannot be done in one call. Act on one frame at a time.',
      );
    }
    return { params: out, frameId: frames.values().next().value ?? 0 };
  }

  /** Rewrites a captured subtree's refs into the global namespace. */
  function remapTree(nodes: DomNode[], frameId: number, map: Map<number, FrameRef>): void {
    for (const node of nodes) {
      if (node.ref != null) {
        globalRefCounter++;
        map.set(globalRefCounter, { frameId, localRef: node.ref });
        node.ref = globalRefCounter;
      }
      if (node.children) remapTree(node.children, frameId, map);
    }
  }

  /**
   * Captures the top frame plus every reachable child frame, presenting each
   * child's tree beneath a labelled node so the agent can see it belongs to an
   * embedded document.
   */
  async function handleSnapshot(
    params: Record<string, unknown>,
    tabId?: number,
  ): Promise<PageSnapshot> {
    const targetTabId = tabId;
    if (!targetTabId) throw new Error('No active tab found');

    const snap = (await routeToContentScript(
      'snapshot',
      { ...params, frameId: 0 },
      targetTabId,
      0,
    )) as PageSnapshot;
    const map = new Map<number, FrameRef>();
    globalRefCounter = 0;
    remapTree(snap.tree, 0, map);

    let frames: chrome.webNavigation.GetAllFrameResultDetails[] = [];
    try {
      frames = (await chrome.webNavigation.getAllFrames({ tabId: targetTabId })) ?? [];
    } catch {
      // webNavigation unavailable; top frame only.
    }

    for (const frame of frames) {
      if (frame.frameId === 0) continue;
      // about:blank and data: frames have no content script and no useful content.
      if (!/^https?:/i.test(frame.url)) continue;
      try {
        const sub = (await routeToContentScript(
          'snapshot',
          { ...params, frameId: frame.frameId },
          targetTabId,
          frame.frameId,
        )) as PageSnapshot;
        if (!sub?.tree?.length) continue;
        remapTree(sub.tree, frame.frameId, map);
        snap.tree.push({ role: 'iframe', name: sub.title || frame.url, children: sub.tree });
      } catch {
        // A frame with no injected script (cross-origin restrictions, sandboxed)
        // is skipped rather than failing the whole snapshot.
      }
    }

    frameRefsByTab.set(targetTabId, map);
    return snap;
  }

  /**
   * Reads the visible label of the element a click will land on, so a "Place
   * order · $249" button can be recognised as destructive before it is pressed.
   * Best-effort: if it cannot be read, the action is classified without it.
   */
  async function labelForClick(
    action: string,
    params: Record<string, unknown>,
    tabId: number,
  ): Promise<string | undefined> {
    if (action === 'click_by_text') return String(params.text ?? '');
    if (params.ref == null) return undefined;
    try {
      const res = (await routeToContentScript('get_text', { ref: params.ref }, tabId)) as {
        text?: string;
      };
      return res?.text?.slice(0, 200);
    } catch {
      return undefined;
    }
  }

  /**
   * Every URL a command would act on or reach.
   *
   * The current tab is not the whole story. `navigate` is the case that matters:
   * checking only where the browser already is means a denylisted site is
   * reachable in one call — the page loads, its scripts run, and its content
   * comes back to the agent. The lists then only govern acting *once there*,
   * which is not what anyone setting a denylist believes they configured.
   */
  async function urlsInScopeOf(
    action: string,
    params: Record<string, unknown>,
    currentUrl: string,
  ): Promise<string[]> {
    const urls = [currentUrl, ...destinationUrls(action, params)];

    if (action === 'switch_tab' && typeof params.tabId === 'number') {
      try {
        urls.push((await chrome.tabs.get(params.tabId)).url ?? '');
      } catch {
        /* tab is gone; the handler will report that better than we can */
      }
    }

    return urls.filter(Boolean);
  }

  /**
   * Classifies the command and blocks on the user when policy demands it.
   * Throws for a denial so the refusal travels back to the agent as a tool
   * error, with a reason it can act on rather than a bare failure.
   */
  async function enforcePolicy(
    action: string,
    params: Record<string, unknown>,
    tabId?: number,
  ): Promise<void> {
    const targetTabId = tabId;
    const url = targetTabId ? ((await chrome.tabs.get(targetTabId)).url ?? '') : '';

    const label = targetTabId ? await labelForClick(action, params, targetTabId) : undefined;
    const risk = classify(action, label);

    const urls = await urlsInScopeOf(action, params, url);
    const denial = firstDomainDenial(policy, urls, risk, action);
    if (denial) throw refusal(`Blocked by user policy: ${denial}`);

    const decision = evaluatePolicy(policy, risk, url, action);
    if (decision.verdict === 'allow') return;
    if (decision.verdict === 'deny') throw refusal(`Blocked by user policy: ${decision.reason}`);

    const detail =
      action === 'navigate'
        ? String(params.url ?? '')
        : label
          ? `"${label.replace(/\s+/g, ' ').trim()}"`
          : Object.keys(params).length
            ? JSON.stringify(params).slice(0, 160)
            : '';

    const approved = await requestApproval(action, risk, decision.reason, detail, url);
    if (!approved) {
      throw refusal(
        `The user declined this action (${action}). Do not retry it; ask them what they would like instead.`,
      );
    }

    // An approval can sit on screen for minutes, and a page is free to redirect
    // while it does. Without this re-check the user approves an action against
    // one origin and it executes against another — and the domain decision above
    // was made against a URL that no longer applies.
    if (targetTabId) {
      const nowUrl = (await chrome.tabs.get(targetTabId).catch(() => ({ url: '' })))?.url ?? '';
      if (originOf(nowUrl) !== originOf(url)) {
        throw refusal(
          `The page moved from ${originOf(url) || 'about:blank'} to ${originOf(nowUrl) || 'about:blank'} ` +
            'while the user was deciding, so the approval no longer applies. ' +
            'Take a fresh snapshot and ask again if you still need this.',
        );
      }
      const after = firstDomainDenial(
        policy,
        await urlsInScopeOf(action, params, nowUrl),
        risk,
        action,
      );
      if (after) throw refusal(`Blocked by user policy: ${after}`);
    }
  }

  /** Fails closed: no answer means denied. */
  function requestApproval(
    action: string,
    risk: RiskClass,
    reason: string,
    detail: string,
    url: string,
  ): Promise<boolean> {
    if (approvalRequest) {
      approvalRequest.resolve(false);
      clearTimeout(approvalRequest.timer);
    }
    void openPanelHint();

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (approvalRequest?.resolve === resolve) approvalRequest = null;
        updateBadge('on');
        resolve(false);
      }, APPROVAL_TTL_MS);

      approvalRequest = { action, risk, reason, detail, url, resolve, timer, askedAt: Date.now() };
      updateBadge('ask');
    });
  }

  function resolveApproval(allow: boolean): void {
    if (!approvalRequest) return;
    clearTimeout(approvalRequest.timer);
    const { resolve } = approvalRequest;
    approvalRequest = null;
    updateBadge('on');
    resolve(allow);
  }

  /**
   * Runs an action as real, trusted input via CDP, falling back to the old
   * synthetic-event path when the debugger cannot attach (DevTools already open
   * on the tab, restricted pages). The fallback is degraded — untrusted events
   * are rejected by some sites — so it is recorded in the activity feed.
   */
  async function handleTrustedAction(
    action: string,
    params: Record<string, unknown>,
    tabId?: number,
    frameId = 0,
  ): Promise<unknown> {
    const targetTabId = tabId;
    if (!targetTabId) throw new Error('No active tab found');

    try {
      switch (action) {
        case 'type':
          await trusted.typeText(
            targetTabId,
            params.ref as number,
            String(params.text ?? ''),
            { clear: Boolean(params.clear), submit: Boolean(params.submit) },
            frameId,
          );
          return { success: true, trusted: true };

        case 'hover':
          await trusted.hover(targetTabId, params.ref as number, frameId);
          return { success: true, trusted: true };

        case 'press_key':
          await trusted.pressKey(
            targetTabId,
            String(params.key ?? ''),
            (params.modifiers as string[]) ?? [],
          );
          return { success: true, trusted: true };

        case 'drag':
          await trusted.dragAndDrop(
            targetTabId,
            params.fromRef as number,
            params.toRef as number,
            frameId,
          );
          return { success: true, trusted: true };

        case 'evaluate':
          return {
            result: await trusted.evaluate(
              targetTabId,
              String(params.script ?? ''),
              params.ref as number | undefined,
              frameId,
            ),
          };
      }
    } catch (err) {
      if (!(err instanceof CdpUnavailable)) throw err;
      degraded = err.message;
    }

    return routeToContentScript(action, params, targetTabId, frameId);
  }

  /**
   * Clicks with a real trusted pointer. `click_by_text` first resolves the text
   * to a ref through the content script, then clicks that ref via CDP — so the
   * convenience of text targeting keeps the fidelity of trusted input.
   */
  async function clickTrustedOrFallback(
    action: string,
    params: Record<string, unknown>,
    tabId: number,
    frameId = 0,
  ): Promise<unknown> {
    try {
      let ref = params.ref as number | undefined;

      if (action === 'click_by_text') {
        // `click_by_text` carries no ref, so `localiseRefs` cannot tell which
        // frame it means. Text is resolved in the top frame, and the resulting
        // ref is therefore a top-frame ref.
        const matches = (await routeToContentScript(
          'find',
          { text: params.text, role: params.role },
          tabId,
          frameId,
        )) as Array<{ ref: number }>;
        if (!matches?.length) throw new Error(`No element found with text "${params.text}"`);
        ref = matches[Math.min((params.index as number) ?? 0, matches.length - 1)]?.ref;
      }

      if (ref == null) throw new Error('No element ref to click');

      await trusted.click(
        tabId,
        ref,
        {
          button: params.button as string | undefined,
          doubleClick: Boolean(params.doubleClick),
          modifiers: params.modifiers as string[] | undefined,
        },
        frameId,
      );
      return { success: true, trusted: true };
    } catch (err) {
      if (!(err instanceof CdpUnavailable)) throw err;
      degraded = err.message;
      return routeToContentScript(action, params, tabId, frameId);
    }
  }

  async function handleClickWithNavDetection(
    action: string,
    params: Record<string, unknown>,
    tabId?: number,
    frameId = 0,
  ): Promise<unknown> {
    const targetTabId = tabId;
    if (!targetTabId) throw new Error('No active tab found');

    const tabBefore = await chrome.tabs.get(targetTabId);
    const urlBefore = tabBefore.url ?? '';

    const domBefore = await domSignature(targetTabId, frameId);
    const result = await clickTrustedOrFallback(action, params, targetTabId, frameId);

    // Check if the tab URL changed (navigation happened)
    await new Promise((r) => setTimeout(r, 300));
    const tabAfter = await chrome.tabs.get(targetTabId);
    const urlAfter = tabAfter.url ?? '';

    if (urlAfter !== urlBefore) {
      // Navigation happened — wait for it to finish, then re-snapshot the new page
      await waitForNavigation(targetTabId);
      const fresh = await handleSnapshot({}, targetTabId);
      return { ...fresh, changed: { navigated: true, from: urlBefore, to: urlAfter } };
    }

    // Nothing navigated, so say whether the DOM moved at all. Without this the
    // agent cannot tell "clicked and something happened" from "clicked into the
    // void" — the usual cause of it confidently continuing down a dead path.
    const domAfter = await domSignature(targetTabId, frameId);
    const changed = domBefore != null && domAfter != null && domBefore !== domAfter;

    return {
      ...(result as Record<string, unknown>),
      changed: {
        navigated: false,
        domChanged: changed,
        ...(changed
          ? {}
          : { hint: 'The page did not visibly change. Verify the click landed on what you intended before continuing.' }),
      },
    };
  }

  /**
   * Console capture needs CDP — there is no extension API for reading a page's
   * console. Enabling it is best-effort so a tab where the debugger cannot
   * attach still answers, with an explanation instead of a silent empty list.
   */
  async function handleConsoleLogs(
    params: { level?: string; clear?: boolean },
    tabId?: number,
  ): Promise<{ logs: unknown[]; note?: string }> {
    const targetTabId = tabId;
    if (!targetTabId) throw new Error('No active tab found');

    try {
      await enableConsoleCapture(targetTabId);
    } catch (err) {
      if (err instanceof CdpUnavailable) {
        return {
          logs: [],
          note: `Console capture unavailable: ${err.message}. Reload the tab after closing DevTools.`,
        };
      }
      throw err;
    }

    let logs = getConsole(targetTabId);
    if (params.level) logs = logs.filter((l) => l.level === params.level);
    if (params.clear) clearConsole(targetTabId);

    return {
      logs: logs.slice(-100),
      note: logs.length
        ? undefined
        : 'No console output captured yet. Capture starts when onbridge first attaches to the tab, so messages logged before that — including at page load — are not recorded. Reload the page to see them.',
    };
  }

  /**
   * A cheap fingerprint of the document, used only to detect that *something*
   * changed. Deliberately coarse — a full diff would cost more than it is worth
   * on every click.
   */
  async function domSignature(tabId: number, frameId = 0): Promise<string | null> {
    try {
      const res = (await routeToContentScript(
        'evaluate',
        { script: 'return document.body ? document.body.innerHTML.length + ":" + document.title : ""' },
        tabId,
        frameId,
      )) as { result?: unknown };
      return typeof res?.result === 'string' ? res.result : null;
    } catch {
      return null;
    }
  }

  async function routeToContentScript(
    action: string,
    params: Record<string, unknown>,
    tabId?: number,
    frameId = 0,
  ): Promise<unknown> {
    const targetTabId = tabId;
    if (!targetTabId) throw new Error('No active tab found');

    if (frameId === 0) await ensureContentScript(targetTabId);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Content script timed out')), 25000);

      chrome.tabs.sendMessage(
        targetTabId,
        { type: 'command', id: `cs_${Date.now()}`, action, params },
        { frameId },
        (response) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response) {
            reject(new Error('No response from content script'));
            return;
          }
          if (response.success) {
            resolve(response.data);
          } else {
            reject(new Error(response.error ?? 'Command failed'));
          }
        },
      );
    });
  }

  async function ensureContentScript(tabId: number): Promise<void> {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-scripts/content.js'],
      });
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async function handleNavigate(params: { url: string }, tabId?: number): Promise<unknown> {
    const targetTabId = tabId;
    if (!targetTabId) throw new Error('No active tab');

    await chrome.tabs.update(targetTabId, { url: params.url });
    await waitForNavigation(targetTabId);
    return routeToContentScript('snapshot', {}, targetTabId);
  }

  async function handleGoBack(tabId?: number): Promise<{ url: string; title: string }> {
    const targetTabId = tabId;
    if (!targetTabId) throw new Error('No active tab');
    await chrome.tabs.goBack(targetTabId);
    await waitForNavigation(targetTabId);
    const tab = await chrome.tabs.get(targetTabId);
    return { url: tab.url ?? '', title: tab.title ?? '' };
  }

  async function handleGoForward(tabId?: number): Promise<{ url: string; title: string }> {
    const targetTabId = tabId;
    if (!targetTabId) throw new Error('No active tab');
    await chrome.tabs.goForward(targetTabId);
    await waitForNavigation(targetTabId);
    const tab = await chrome.tabs.get(targetTabId);
    return { url: tab.url ?? '', title: tab.title ?? '' };
  }

  async function handleReload(params: { hard?: boolean }, tabId?: number): Promise<{ url: string; title: string }> {
    const targetTabId = tabId;
    if (!targetTabId) throw new Error('No active tab');
    await chrome.tabs.reload(targetTabId, { bypassCache: params.hard });
    await waitForNavigation(targetTabId);
    const tab = await chrome.tabs.get(targetTabId);
    return { url: tab.url ?? '', title: tab.title ?? '' };
  }

  function waitForNavigation(tabId: number): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, 10000);
      const listener = (updatedTabId: number, info: chrome.tabs.OnUpdatedInfo) => {
        if (updatedTabId === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          setTimeout(resolve, 300);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  /**
   * Only the tabs this session may touch. Listing tabs it cannot act on would
   * hand one agent a map of another agent's windows, and invite it to try.
   */
  async function handleListTabs(
    session: AgentSession,
  ): Promise<Array<{ id: number; url: string; title: string; active: boolean }>> {
    const scope = session.scope;
    if (!scope) return [];

    let tabs: chrome.tabs.Tab[];
    if (scope.kind === 'tab') {
      tabs = scope.tabId ? [await chrome.tabs.get(scope.tabId)] : [];
    } else if (scope.kind === 'window') {
      tabs = scope.windowId != null ? await chrome.tabs.query({ windowId: scope.windowId }) : [];
    } else {
      tabs = await chrome.tabs.query({});
    }
    return tabs.map((t) => ({ id: t.id!, url: t.url ?? '', title: t.title ?? '', active: t.active ?? false }));
  }

  async function handleSwitchTab(
    session: AgentSession,
    params: { tabId: number },
  ): Promise<{ url: string; title: string }> {
    await enforceScope(session, params.tabId);
    await chrome.tabs.update(params.tabId, { active: true });
    const tab = await chrome.tabs.get(params.tabId);
    return { url: tab.url ?? '', title: tab.title ?? '' };
  }

  async function handleNewTab(
    session: AgentSession,
    params: { url?: string },
  ): Promise<{ tabId: number; url: string; title: string }> {
    const scope = session.scope;
    if (!scope || scope.kind === 'tab') {
      throw refusal(
        'Access denied: this agent controls a single tab, and a new tab would fall outside it. ' +
          'Ask the user to grant window-level control instead.',
      );
    }
    const createOpts: chrome.tabs.CreateProperties = { url: params.url };
    // Pin the new tab into the granted window so it lands inside the scope
    // rather than wherever Chrome last had focus.
    if (scope.kind === 'window' && scope.windowId != null) {
      createOpts.windowId = scope.windowId;
    }
    const tab = await chrome.tabs.create(createOpts);
    if (params.url) {
      await waitForNavigation(tab.id!);
      const updated = await chrome.tabs.get(tab.id!);
      return { tabId: updated.id!, url: updated.url ?? '', title: updated.title ?? '' };
    }
    return { tabId: tab.id!, url: tab.url ?? '', title: tab.title ?? '' };
  }

  async function handleCloseTab(
    session: AgentSession,
    params: { tabId?: number },
    fallbackTabId?: number,
  ): Promise<{ success: boolean }> {
    const targetTabId = params.tabId ?? fallbackTabId;
    if (!targetTabId) throw new Error('No active tab');
    await enforceScope(session, targetTabId);
    await chrome.tabs.remove(targetTabId);
    return { success: true };
  }

  /**
   * `fullPage` and `quality` were accepted by the tool schema but ignored here —
   * every screenshot came back as a viewport-only JPEG at quality 60. CDP's
   * captureScreenshot honours both; captureVisibleTab cannot do full-page at all.
   */
  async function handleScreenshot(
    params: { fullPage?: boolean; quality?: number },
    tabId?: number,
  ): Promise<{ base64: string }> {
    const targetTabId = tabId;
    if (targetTabId) {
      try {
        return { base64: await trusted.screenshot(targetTabId, params) };
      } catch (err) {
        if (!(err instanceof CdpUnavailable)) throw err;
        degraded = err.message;
      }
    }

    // Fallback: viewport only, so a fullPage request is silently downgraded.
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined as unknown as number, {
      format: 'jpeg',
      quality: params.quality ?? 60,
    });
    return { base64: dataUrl.replace(/^data:image\/jpeg;base64,/, '') };
  }

  /**
   * Values are withheld unless explicitly asked for. A session cookie pasted
   * into an agent transcript is a live credential that outlives the
   * conversation — it gets logged, cached, and possibly summarised elsewhere.
   * Names and domains answer almost every legitimate question ("am I logged
   * in?") without handing over the key.
   */
  async function handleGetCookies(
    params: {
      domain?: string;
      includeValues?: boolean;
    },
    tabId?: number,
  ): Promise<{ cookies: Array<Record<string, unknown>>; redacted: boolean; note?: string }> {
    const query: chrome.cookies.GetAllDetails = {};
    if (params.domain) query.domain = params.domain;
    else {
      if (tabId) {
        const tab = await chrome.tabs.get(tabId);
        if (tab.url) query.url = tab.url;
      }
    }

    const cookies = await chrome.cookies.getAll(query);
    const reveal = Boolean(params.includeValues);

    return {
      redacted: !reveal,
      note: reveal
        ? undefined
        : 'Values withheld. They are live credentials; do not request them unless the task genuinely cannot proceed without them.',
      cookies: cookies.map((c) => ({
        name: c.name,
        domain: c.domain,
        secure: c.secure,
        httpOnly: c.httpOnly,
        session: c.session,
        ...(reveal ? { value: c.value } : { valueLength: c.value.length }),
      })),
    };
  }

  async function handleSetCookie(params: { name: string; value: string; domain: string }): Promise<{ success: boolean }> {
    await chrome.cookies.set({
      url: `https://${params.domain}`,
      name: params.name,
      value: params.value,
      domain: params.domain,
    });
    return { success: true };
  }

  async function handleDownloadFile(params: { url?: string; ref?: number }): Promise<{ filename: string; path: string; id: number }> {
    let downloadUrl = params.url;

    if (!downloadUrl && params.ref != null) {
      const hrefResult = await routeToContentScript('dom_query', {
        selector: `[data-onbridge-ref="${params.ref}"]`,
        action: 'text',
      }) as { text: string };
      // Try to get href via evaluate as fallback
      try {
        const evalResult = await routeToContentScript('evaluate', {
          script: `return element.href || element.src || ''`,
          ref: params.ref,
        }) as { result: string };
        downloadUrl = evalResult.result;
      } catch {
        throw new Error('Could not extract URL from element');
      }
    }

    if (!downloadUrl) throw new Error('No URL to download');

    return new Promise((resolve, reject) => {
      chrome.downloads.download({ url: downloadUrl! }, (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        const listener = (delta: chrome.downloads.DownloadDelta) => {
          if (delta.id !== downloadId) return;
          if (delta.state?.current === 'complete') {
            chrome.downloads.onChanged.removeListener(listener);
            chrome.downloads.search({ id: downloadId }, (items) => {
              const item = items[0];
              resolve({
                filename: item?.filename?.split('/').pop() ?? '',
                path: item?.filename ?? '',
                id: downloadId,
              });
            });
          } else if (delta.state?.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(listener);
            reject(new Error(`Download interrupted`));
          }
        };
        chrome.downloads.onChanged.addListener(listener);
      });
    });
  }

  async function handleListDownloads(params: { limit?: number }): Promise<Array<{ filename: string; path: string; state: string; size: number; url: string }>> {
    const limit = params.limit ?? 10;
    return new Promise((resolve) => {
      chrome.downloads.search({ limit, orderBy: ['-startTime'] }, (items) => {
        resolve(items.map((item) => ({
          filename: item.filename?.split('/').pop() ?? '',
          path: item.filename ?? '',
          state: item.state ?? 'unknown',
          size: item.totalBytes ?? 0,
          url: item.url ?? '',
        })));
      });
    });
  }

  async function handleFileUpload(params: { ref: number; filePath: string }, tabId?: number): Promise<{ success: boolean }> {
    const targetTabId = tabId;
    if (!targetTabId) throw new Error('No active tab');

    // Use Chrome Debugger API (CDP) to set files on file inputs
    const debugTarget = { tabId: targetTabId };

    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach(debugTarget, '1.3', () => {
        if (chrome.runtime.lastError) {
          reject(new Error(`Debugger attach failed: ${chrome.runtime.lastError.message}`));
        } else {
          resolve();
        }
      });
    });

    try {
      // Find the file input element using the ref attribute
      const docResult = await cdpSend(debugTarget, 'DOM.getDocument', {});
      const nodeResult = await cdpSend(debugTarget, 'DOM.querySelector', {
        nodeId: docResult.root.nodeId,
        selector: `[data-onbridge-ref="${params.ref}"]`,
      });

      if (!nodeResult.nodeId) {
        // Fallback: try to find any file input
        const fallbackResult = await cdpSend(debugTarget, 'DOM.querySelector', {
          nodeId: docResult.root.nodeId,
          selector: 'input[type="file"]',
        });
        if (!fallbackResult.nodeId) {
          throw new Error(`File input with ref ${params.ref} not found`);
        }
        nodeResult.nodeId = fallbackResult.nodeId;
      }

      await cdpSend(debugTarget, 'DOM.setFileInputFiles', {
        nodeId: nodeResult.nodeId,
        files: [params.filePath],
      });

      return { success: true };
    } finally {
      chrome.debugger.detach(debugTarget, () => {});
    }
  }

  function cdpSend(target: { tabId: number }, method: string, params: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(target, method, params, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result);
        }
      });
    });
  }


  function updateBadge(
    state: 'disabled' | 'off' | 'on' | 'active' | 'pair' | 'ask' | 'paused' | 'yolo',
  ) {
    // A pending question outranks anything else — the agent is blocked on it.
    if (askRequest || approvalRequest) state = 'ask';
    else if (paused && (state === 'on' || state === 'active')) state = 'paused';
    // Bypass mode must be impossible to miss while it is on.
    else if (policy.mode === 'yolo' && (state === 'on' || state === 'active')) state = 'yolo';

    const colors: Record<string, string> = {
      disabled: '#666',
      off: '#666',
      on: '#00d4aa',
      active: '#3b82f6',
      pair: '#f59e0b',
      ask: '#f59e0b',
      paused: '#a855f7',
      yolo: '#ef4444',
    };
    const labels: Record<string, string> = {
      disabled: '',
      off: 'OFF',
      on: 'ON',
      active: '...',
      pair: '?',
      ask: '?',
      paused: 'II',
      yolo: '!',
    };
    chrome.action.setBadgeBackgroundColor({ color: colors[state] });
    chrome.action.setBadgeText({ text: labels[state] });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'get_status') {
      // The panel tells us which window it is in. Everything about "who is
      // driving" is answered relative to that window — a panel in window A must
      // not report the agent that owns window B as if it were in charge here.
      const windowId = typeof message.windowId === 'number' ? message.windowId : undefined;
      const sessions = manager.list();
      const mine = windowId != null ? manager.sessionForWindow(windowId) : undefined;

      const view = (s: AgentSession) => ({
        id: s.id,
        port: s.port,
        status: s.status,
        detail: s.detail,
        scope: s.scope,
        scopeLabel: s.scope ? describeScope(s.scope) : null,
        commandCount: s.commandCount,
        attempts: s.attempts,
        lastAction: s.lastAction,
        connectedAt: s.connectedAt,
        /** Owns the window this panel is in — drives the "controlling" heading. */
        ownsThisWindow: mine?.id === s.id,
        agent: s.identity
          ? {
              name: s.identity.name,
              version: s.identity.version,
              source: s.identity.source,
              pid: s.identity.pid,
              cwd: s.identity.cwd,
              serverVersion: s.identity.serverVersion,
            }
          : null,
      });

      sendResponse({
        controlMode,
        windowId,
        sessions: sessions.map(view),
        activeSessionId: mine?.id ?? null,
        connected: Boolean(mine),
        anyConnected: sessions.some((s) => s.status === 'active' || s.status === 'on_hold'),
        preferredScope,
        paused,
        degraded,
        policy,
        yoloExpiresAt,
        approvalRequest: approvalRequest
          ? {
              action: approvalRequest.action,
              risk: approvalRequest.risk,
              reason: approvalRequest.reason,
              detail: approvalRequest.detail,
              url: approvalRequest.url,
              askedAt: approvalRequest.askedAt,
            }
          : null,
        pairBlocked,
        // Whether a newly-appearing agent would be offered to the user at all.
        // Once this closes, a new agent cannot get in without a deliberate
        // gesture, which is worth being able to see rather than infer.
        pairWindowOpen: controlMode && Date.now() - controlEnabledAt <= PAIR_WINDOW_MS,
        pairRequest: pairRequest
          ? {
              port: pairRequest.port,
              wasPaired: pairRequest.wasPaired,
              agent: {
                name: pairRequest.agent.name,
                version: pairRequest.agent.version,
                source: pairRequest.agent.source,
                pid: pairRequest.agent.pid,
                cwd: pairRequest.agent.cwd,
                serverVersion: pairRequest.agent.serverVersion,
              },
            }
          : null,
        askRequest: askRequest
          ? { question: askRequest.question, options: askRequest.options, askedAt: askRequest.askedAt }
          : null,
        lastAction: mine?.lastAction ?? '',
        activityLog: (mine?.activityLog ?? []).slice(0, 30),
        commandCount: mine?.commandCount ?? 0,
      });
      return true;
    }

    /**
     * Hands a session territory. The window comes from the panel that asked, so
     * "give this agent control" always means the window the user is looking at.
     */
    if (message?.type === 'activate_session') {
      const kind = (message.scope as ScopeKind) ?? preferredScope;
      buildScope(kind, message.windowId as number | undefined).then((scope) => {
        const res = manager.activate(String(message.id), scope);
        if (res.ok) {
          void manager.send(String(message.id), {
            type: 'ready',
            version: chrome.runtime.getManifest().version,
            controlMode: true,
          });
        }
        sendResponse(res);
      });
      return true;
    }

    if (message?.type === 'hold_session') {
      manager.hold(String(message.id));
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === 'disconnect_session') {
      manager.disconnect(String(message.id));
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === 'resolve_approval') {
      resolveApproval(Boolean(message.allow));
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === 'set_policy') {
      policy = { ...policy, ...(message.policy as Partial<Policy>) };
      chrome.storage.local.set({ policy });
      sendResponse({ ok: true, policy });
      return true;
    }

    // Reachable only from the extension's own pages. There is deliberately no
    // MCP tool for this: an agent able to widen its own permissions would make
    // every approval prompt meaningless.
    if (message?.type === 'set_approval_mode') {
      const mode = message.mode as ApprovalMode;
      if (mode !== 'yolo' && mode !== 'auto' && mode !== 'strict') {
        sendResponse({ ok: false, reason: 'unknown mode' });
        return true;
      }
      policy = { ...policy, mode };
      chrome.storage.local.set({ policy });

      if (yoloTimer) {
        clearTimeout(yoloTimer);
        yoloTimer = null;
      }
      if (mode === 'yolo') {
        yoloExpiresAt = Date.now() + YOLO_TIMEOUT_MINUTES * 60_000;
        // Falls back on its own so an unattended run cannot leave the browser
        // permanently unguarded.
        yoloTimer = setTimeout(() => {
          policy = { ...policy, mode: 'auto' };
          yoloExpiresAt = 0;
          chrome.storage.local.set({ policy });
          void chrome.notifications
            ?.create({
              type: 'basic',
              iconUrl: chrome.runtime.getURL('icon.svg'),
              title: 'onbridge — approvals re-enabled',
              message: `Bypass mode expired after ${YOLO_TIMEOUT_MINUTES} minutes.`,
              priority: 1,
            })
            .catch(() => {});
        }, YOLO_TIMEOUT_MINUTES * 60_000);
      } else {
        yoloExpiresAt = 0;
      }

      updateBadge(manager.hasActive() ? 'on' : 'off');
      sendResponse({ ok: true, mode, expiresAt: yoloExpiresAt || undefined });
      return true;
    }

    if (message?.type === 'answer_ask') {
      resolveAsk(typeof message.answer === 'string' ? message.answer : null);
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === 'send_user_message') {
      const text = String(message.text ?? '').trim();
      if (!text) {
        sendResponse({ ok: false, reason: 'empty' });
        return true;
      }
      // If the agent is waiting on a question, this IS the answer — deliver it
      // directly instead of queueing it for an unknown later moment.
      if (askRequest) {
        resolveAsk(text);
        sendResponse({ ok: true, delivered: 'answered' });
        return true;
      }
      if (!manager.hasActive()) {
        sendResponse({ ok: false, reason: 'not_connected' });
        return true;
      }
      // Goes to every agent currently holding territory. With two agents driving
      // two windows there is no way to know which one a free-form note is for,
      // and silently picking one would put it in front of the wrong session.
      void manager.broadcastActive({ type: 'event', event: 'user_message', data: { text } });
      sendResponse({ ok: true, delivered: 'queued' });
      return true;
    }

    if (message?.type === 'set_paused') {
      paused = Boolean(message.paused);
      updateBadge(manager.hasActive() ? 'on' : 'off');
      sendResponse({ ok: true, paused });
      return true;
    }

    /**
     * Re-opens the pairing window on an explicit user gesture.
     *
     * This is the only way back in once the window has lapsed, and it is
     * deliberately a click in the extension's own UI: that is what separates a
     * user who wants a second agent from a process trying to nag them.
     */
    if (message?.type === 'arm_pairing') {
      controlEnabledAt = Date.now();
      pairBlocked = null;
      updateBadge(controlMode ? 'on' : 'off');
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === 'resolve_pairing') {
      resolvePairing(Boolean(message.allow));
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === 'clear_pairings') {
      clearPairings().then(() => {
        disconnect();
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message?.type === 'set_control_mode') {
      controlMode = message.enabled;
      chrome.storage.local.set({ controlMode });
      if (controlMode) {
        controlEnabledAt = Date.now();
        pairBlocked = null;
        manager.start();
      } else {
        disconnect();
      }
      sendResponse({ ok: true });
      return true;
    }

    // The default grant offered when the user hands an agent control. Changing
    // it never widens a grant already made — existing sessions keep the scope
    // they were given until the user explicitly re-grants.
    if (message?.type === 'set_scope') {
      preferredScope = message.scope as ScopeKind;
      chrome.storage.local.set({ preferredScope });
      sendResponse({ ok: true, preferredScope });
      return true;
    }

    if (message?.type === 'clear_activity_log') {
      const target = message.id ? manager.get(String(message.id)) : undefined;
      const targets = target ? [target] : manager.list();
      for (const s of targets) {
        s.activityLog = [];
        s.commandCount = 0;
      }
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });

  // Clicking the toolbar icon opens the cockpit directly. This only works with
  // no default_popup in the manifest — a popup takes precedence and would make
  // the panel a second click. It also supplies the user gesture that
  // chrome.sidePanel.open() demands, which is why a pending question can only
  // *ask* to be opened (badge + notification), never force it.
  if (chrome.sidePanel) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  } else {
    // Chrome < 114: no side panel API. Fall back to a normal tab so the
    // extension is never left with no reachable UI at all.
    chrome.action.onClicked.addListener(() => {
      void chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') });
    });
  }

  chrome.notifications?.onClicked.addListener(() => {
    chrome.notifications.clear('');
  });

  /**
   * Control mode should not survive being forgotten about. If the agent has
   * been idle past the configured window, revoke access rather than leaving the
   * browser indefinitely drivable because someone left a tab open days ago.
   */
  setInterval(() => {
    if (!controlMode || !policy.idleRevokeMinutes) return;
    const idleMs = Date.now() - lastCommandAt;
    if (idleMs < policy.idleRevokeMinutes * 60_000) return;

    controlMode = false;
    chrome.storage.local.set({ controlMode: false });
    disconnect();
    void chrome.notifications
      ?.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon.svg'),
        title: 'onbridge — control mode turned off',
        message: `No agent activity for ${policy.idleRevokeMinutes} minutes.`,
        priority: 1,
      })
      .catch(() => {});
  }, 60_000);

  // A completed navigation is a natural moment to retry CDP: whatever blocked
  // attach (usually DevTools being open) may since have gone away, and without
  // this the tab would stay stuck on the degraded synthetic-event path forever.
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'complete') {
      forgetRefusal(tabId);
      degraded = '';
    }
  });

  updateBadge('disabled');
});
