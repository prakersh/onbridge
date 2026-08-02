import { defineBackground } from 'wxt/utils/define-background';
import type { ServerMessage, ExtensionMessage, DomNode, PageSnapshot } from '@onbridge/shared';
import { SecureClient, clearPairings, type ClientState } from '../core/secure-client.js';
import { CdpUnavailable, detachAll, forgetRefusal } from '../core/cdp.js';
import * as trusted from '../core/trusted-input.js';
import {
  classify,
  evaluatePolicy,
  DEFAULT_POLICY,
  type Policy,
  type RiskClass,
} from '../core/policy.js';

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

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

interface ActivityEntry {
  action: string;
  summary: string;
  success: boolean;
  error?: string;
  timing: number;
  timestamp: number;
}

export default defineBackground(() => {
  let client: SecureClient | null = null;
  let clientState: ClientState = 'idle';
  let stateDetail = '';
  let controlMode = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastAction = '';
  let activityLog: ActivityEntry[] = [];
  let commandCount = 0;

  /** Set when the user flips control mode on — gates the pairing prompt. */
  let controlEnabledAt = 0;
  let pairRequest:
    | { agentName: string; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }
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

  type AccessScope = 'current_tab' | 'current_window' | 'all_tabs';
  let accessScope: AccessScope = 'current_tab';
  let scopeTabId: number | undefined;
  let scopeWindowId: number | undefined;

  chrome.storage.local.get(['controlMode', 'accessScope', 'policy'], (result) => {
    if (result.accessScope) accessScope = result.accessScope as AccessScope;
    if (result.policy) policy = { ...DEFAULT_POLICY, ...(result.policy as Policy) };
    if (result.controlMode) {
      controlMode = true;
      captureScope().then(() => connect());
    }
  });

  async function captureScope() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    scopeTabId = tab?.id;
    scopeWindowId = tab?.windowId;
  }

  async function enforceScope(tabId: number): Promise<void> {
    if (accessScope === 'all_tabs') return;

    if (accessScope === 'current_tab') {
      if (tabId !== scopeTabId) {
        throw new Error(`Access denied: agent is scoped to current tab only (tab ${scopeTabId}). Requested tab ${tabId}.`);
      }
      return;
    }

    if (accessScope === 'current_window') {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId !== scopeWindowId) {
        throw new Error(`Access denied: agent is scoped to current window only. Tab ${tabId} is in a different window.`);
      }
    }
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
  function requestPairing(agentName: string): Promise<boolean> {
    if (Date.now() - controlEnabledAt > PAIR_WINDOW_MS) {
      return Promise.resolve(false);
    }
    if (pairRequest) pairRequest.resolve(false);

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (pairRequest?.resolve === resolve) pairRequest = null;
        resolve(false);
      }, PAIR_PROMPT_TTL_MS);

      pairRequest = { agentName, resolve, timer };
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

  async function onServerMessage(msg: ServerMessage): Promise<void> {
    if (msg.type === 'ping') {
      await client?.send({ type: 'pong' });
      return;
    }
    if (msg.type !== 'command') return;

    updateBadge('active');
    lastAction = msg.action;
    commandCount++;
    const cmdStart = Date.now();
    const summary = summarizeParams(msg.action, msg.params);

    let response: ExtensionMessage;
    try {
      const data = await handleCommand(msg);
      const timing = Date.now() - cmdStart;
      response = { type: 'result', id: msg.id, success: true, data, timing };
      activityLog.unshift({ action: msg.action, summary, success: true, timing, timestamp: Date.now() });
    } catch (err) {
      const timing = Date.now() - cmdStart;
      const errorMsg = err instanceof Error ? err.message : String(err);
      response = { type: 'result', id: msg.id, success: false, data: null, error: errorMsg, timing };
      activityLog.unshift({
        action: msg.action,
        summary,
        success: false,
        error: errorMsg,
        timing,
        timestamp: Date.now(),
      });
    }

    await client?.send(response);
    if (activityLog.length > 50) activityLog.length = 50;
    updateBadge('on');
  }

  function connect() {
    if (client && client.getState() !== 'idle' && client.getState() !== 'failed') return;

    client = new SecureClient({
      onPairRequest: requestPairing,
      onMessage: (msg) => void onServerMessage(msg),
      onState: (state, detail) => {
        clientState = state;
        stateDetail = detail ?? '';
        if (state === 'ready') {
          reconnectAttempt = 0;
          updateBadge('on');
          void client?.send({ type: 'ready', version: '0.3.0', controlMode: true });
        } else if (state === 'pairing') {
          updateBadge('pair');
        } else if (state === 'idle' || state === 'failed') {
          updateBadge(controlMode ? 'off' : 'disabled');
          if (controlMode) scheduleReconnect();
        }
      },
    });

    void client.connect();
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    resolvePairing(false);
    resolveAsk(null); // never leave the agent blocked on a dead channel
    client?.disconnect();
    client = null;
    clientState = 'idle';
    // Release the debugger so Chrome drops the "onbridge is debugging this
    // browser" banner the moment control mode ends.
    detachAll();
    degraded = '';
    updateBadge('disabled');
  }

  function scheduleReconnect() {
    if (!controlMode) return;
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    reconnectAttempt++;
    reconnectTimer = setTimeout(connect, delay);
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

  async function handleCommand(msg: ServerMessage & { type: 'command' }): Promise<unknown> {
    const { action, params: rawParams, tabId } = msg;
    let params = rawParams;

    // ask_user and bridge_status are meta-commands: they must work even while
    // automation is paused, since answering is exactly how a user unblocks it.
    if (action === 'ask_user') {
      const answer = await askUser(params.question as string, params.options as string[] | undefined);
      return answer == null ? { timedOut: true } : { answer };
    }

    if (action === 'bridge_status') {
      return { accessScope, paused, commandCount, controlMode, degraded: degraded || undefined };
    }

    if (paused) {
      throw new Error(
        'Automation is paused by the user in the onbridge side panel. Ask them to resume before retrying.',
      );
    }

    lastCommandAt = Date.now();
    await enforcePolicy(action, params, tabId);

    // Translate global refs down to per-frame refs before dispatch. Everything
    // below this point works in the target frame's own ref space.
    const targetTabId = tabId ?? (await getActiveTabId());
    let frameId = 0;
    if (targetTabId) {
      const localised = localiseRefs(params, targetTabId);
      params = localised.params;
      frameId = localised.frameId;
    }

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
        return handleListTabs();
      case 'switch_tab':
        return handleSwitchTab(params as { tabId: number });
      case 'new_tab':
        return handleNewTab(params as { url?: string });
      case 'close_tab':
        return handleCloseTab(params as { tabId?: number });
      case 'screenshot':
        return handleScreenshot(params as { fullPage?: boolean; quality?: number }, tabId);
      case 'get_cookies':
        return handleGetCookies(params as { domain?: string });
      case 'set_cookie':
        return handleSetCookie(params as { name: string; value: string; domain: string });
      case 'console_logs':
        return { logs: consoleLogs.slice() };
      case 'download_file':
        return handleDownloadFile(params as { url?: string; ref?: number });
      case 'list_downloads':
        return handleListDownloads(params as { limit?: number });
      case 'activity_log':
        return { entries: activityLog.slice(0, 30), totalCommands: commandCount };
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
    const targetTabId = tabId ?? (await getActiveTabId());
    if (!targetTabId) throw new Error('No active tab found');

    const snap = (await routeToContentScript('snapshot', params, targetTabId, 0)) as PageSnapshot;
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
          params,
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
   * Classifies the command and blocks on the user when policy demands it.
   * Throws for a denial so the refusal travels back to the agent as a tool
   * error, with a reason it can act on rather than a bare failure.
   */
  async function enforcePolicy(
    action: string,
    params: Record<string, unknown>,
    tabId?: number,
  ): Promise<void> {
    const targetTabId = tabId ?? (await getActiveTabId());
    const url = targetTabId ? ((await chrome.tabs.get(targetTabId)).url ?? '') : '';

    const label = targetTabId ? await labelForClick(action, params, targetTabId) : undefined;
    const risk = classify(action, label);
    const decision = evaluatePolicy(policy, risk, url, action);

    if (decision.verdict === 'allow') return;
    if (decision.verdict === 'deny') throw new Error(`Blocked by user policy: ${decision.reason}`);

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
      throw new Error(
        `The user declined this action (${action}). Do not retry it; ask them what they would like instead.`,
      );
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
    const targetTabId = tabId ?? (await getActiveTabId());
    if (!targetTabId) throw new Error('No active tab found');
    await enforceScope(targetTabId);

    // CDP's main-world evaluate cannot resolve a ref inside a child frame, so
    // iframe interaction goes through that frame's content script. Those events
    // are synthetic, which some embedded widgets will ignore.
    if (frameId !== 0) return routeToContentScript(action, params, targetTabId, frameId);

    try {
      switch (action) {
        case 'type':
          await trusted.typeText(targetTabId, params.ref as number, String(params.text ?? ''), {
            clear: Boolean(params.clear),
            submit: Boolean(params.submit),
          });
          return { success: true, trusted: true };

        case 'hover':
          await trusted.hover(targetTabId, params.ref as number);
          return { success: true, trusted: true };

        case 'press_key':
          await trusted.pressKey(
            targetTabId,
            String(params.key ?? ''),
            (params.modifiers as string[]) ?? [],
          );
          return { success: true, trusted: true };

        case 'drag':
          await trusted.dragAndDrop(targetTabId, params.fromRef as number, params.toRef as number);
          return { success: true, trusted: true };

        case 'evaluate':
          return {
            result: await trusted.evaluate(
              targetTabId,
              String(params.script ?? ''),
              params.ref as number | undefined,
            ),
          };
      }
    } catch (err) {
      if (!(err instanceof CdpUnavailable)) throw err;
      degraded = err.message;
    }

    return routeToContentScript(action, params, targetTabId);
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
    // A ref inside an iframe is not resolvable from the main world; that frame's
    // content script handles it with synthetic events instead.
    if (frameId !== 0) return routeToContentScript(action, params, tabId, frameId);

    try {
      let ref = params.ref as number | undefined;

      if (action === 'click_by_text') {
        const matches = (await routeToContentScript(
          'find',
          { text: params.text, role: params.role },
          tabId,
        )) as Array<{ ref: number }>;
        if (!matches?.length) throw new Error(`No element found with text "${params.text}"`);
        ref = matches[Math.min((params.index as number) ?? 0, matches.length - 1)]?.ref;
      }

      if (ref == null) throw new Error('No element ref to click');

      await trusted.click(tabId, ref, {
        button: params.button as string | undefined,
        doubleClick: Boolean(params.doubleClick),
        modifiers: params.modifiers as string[] | undefined,
      });
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
    const targetTabId = tabId ?? (await getActiveTabId());
    if (!targetTabId) throw new Error('No active tab found');

    await enforceScope(targetTabId);
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
    const targetTabId = tabId ?? (await getActiveTabId());
    if (!targetTabId) throw new Error('No active tab found');

    await enforceScope(targetTabId);
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

  async function getActiveTabId(): Promise<number | undefined> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
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
    const targetTabId = tabId ?? (await getActiveTabId());
    if (!targetTabId) throw new Error('No active tab');

    await chrome.tabs.update(targetTabId, { url: params.url });
    await waitForNavigation(targetTabId);
    return routeToContentScript('snapshot', {}, targetTabId);
  }

  async function handleGoBack(tabId?: number): Promise<{ url: string; title: string }> {
    const targetTabId = tabId ?? (await getActiveTabId());
    if (!targetTabId) throw new Error('No active tab');
    await chrome.tabs.goBack(targetTabId);
    await waitForNavigation(targetTabId);
    const tab = await chrome.tabs.get(targetTabId);
    return { url: tab.url ?? '', title: tab.title ?? '' };
  }

  async function handleGoForward(tabId?: number): Promise<{ url: string; title: string }> {
    const targetTabId = tabId ?? (await getActiveTabId());
    if (!targetTabId) throw new Error('No active tab');
    await chrome.tabs.goForward(targetTabId);
    await waitForNavigation(targetTabId);
    const tab = await chrome.tabs.get(targetTabId);
    return { url: tab.url ?? '', title: tab.title ?? '' };
  }

  async function handleReload(params: { hard?: boolean }, tabId?: number): Promise<{ url: string; title: string }> {
    const targetTabId = tabId ?? (await getActiveTabId());
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

  async function handleListTabs(): Promise<Array<{ id: number; url: string; title: string; active: boolean }>> {
    let tabs: chrome.tabs.Tab[];
    if (accessScope === 'current_tab') {
      tabs = scopeTabId ? [await chrome.tabs.get(scopeTabId)] : [];
    } else if (accessScope === 'current_window') {
      tabs = scopeWindowId ? await chrome.tabs.query({ windowId: scopeWindowId }) : [];
    } else {
      tabs = await chrome.tabs.query({});
    }
    return tabs.map((t) => ({ id: t.id!, url: t.url ?? '', title: t.title ?? '', active: t.active ?? false }));
  }

  async function handleSwitchTab(params: { tabId: number }): Promise<{ url: string; title: string }> {
    await enforceScope(params.tabId);
    await chrome.tabs.update(params.tabId, { active: true });
    const tab = await chrome.tabs.get(params.tabId);
    return { url: tab.url ?? '', title: tab.title ?? '' };
  }

  async function handleNewTab(params: { url?: string }): Promise<{ tabId: number; url: string; title: string }> {
    if (accessScope === 'current_tab') {
      throw new Error('Access denied: cannot open new tabs in "current tab" scope.');
    }
    const createOpts: chrome.tabs.CreateProperties = { url: params.url };
    if (accessScope === 'current_window' && scopeWindowId) {
      createOpts.windowId = scopeWindowId;
    }
    const tab = await chrome.tabs.create(createOpts);
    if (params.url) {
      await waitForNavigation(tab.id!);
      const updated = await chrome.tabs.get(tab.id!);
      return { tabId: updated.id!, url: updated.url ?? '', title: updated.title ?? '' };
    }
    return { tabId: tab.id!, url: tab.url ?? '', title: tab.title ?? '' };
  }

  async function handleCloseTab(params: { tabId?: number }): Promise<{ success: boolean }> {
    const targetTabId = params.tabId ?? (await getActiveTabId());
    if (!targetTabId) throw new Error('No active tab');
    await enforceScope(targetTabId);
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
    const targetTabId = tabId ?? (await getActiveTabId());
    if (targetTabId) {
      await enforceScope(targetTabId);
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
  async function handleGetCookies(params: {
    domain?: string;
    includeValues?: boolean;
  }): Promise<{ cookies: Array<Record<string, unknown>>; redacted: boolean; note?: string }> {
    const query: chrome.cookies.GetAllDetails = {};
    if (params.domain) query.domain = params.domain;
    else {
      const tabId = await getActiveTabId();
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
    const targetTabId = tabId ?? (await getActiveTabId());
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

  const consoleLogs: Array<{ level: string; text: string; timestamp: number }> = [];

  function updateBadge(state: 'disabled' | 'off' | 'on' | 'active' | 'pair' | 'ask' | 'paused') {
    // A pending question outranks anything else — the agent is blocked on it.
    if (askRequest && state !== 'ask') state = 'ask';
    else if (paused && (state === 'on' || state === 'active')) state = 'paused';

    const colors: Record<string, string> = {
      disabled: '#666',
      off: '#666',
      on: '#00d4aa',
      active: '#3b82f6',
      pair: '#f59e0b',
      ask: '#f59e0b',
      paused: '#a855f7',
    };
    const labels: Record<string, string> = {
      disabled: '',
      off: 'OFF',
      on: 'ON',
      active: '...',
      pair: '?',
      ask: '?',
      paused: 'II',
    };
    chrome.action.setBadgeBackgroundColor({ color: colors[state] });
    chrome.action.setBadgeText({ text: labels[state] });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'get_status') {
      sendResponse({
        controlMode,
        connected: client?.isReady() ?? false,
        connectionState: clientState,
        stateDetail,
        paused,
        degraded,
        policy,
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
        pairRequest: pairRequest ? { agentName: pairRequest.agentName } : null,
        askRequest: askRequest
          ? { question: askRequest.question, options: askRequest.options, askedAt: askRequest.askedAt }
          : null,
        lastAction,
        activityLog: activityLog.slice(0, 30),
        commandCount,
        accessScope,
      });
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
      if (!client?.isReady()) {
        sendResponse({ ok: false, reason: 'not_connected' });
        return true;
      }
      void client.send({ type: 'event', event: 'user_message', data: { text } });
      sendResponse({ ok: true, delivered: 'queued' });
      return true;
    }

    if (message?.type === 'set_paused') {
      paused = Boolean(message.paused);
      updateBadge(client?.isReady() ? 'on' : 'off');
      sendResponse({ ok: true, paused });
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
        captureScope().then(() => connect());
      } else {
        disconnect();
        scopeTabId = undefined;
        scopeWindowId = undefined;
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === 'set_scope') {
      accessScope = message.scope;
      chrome.storage.local.set({ accessScope });
      if (controlMode) {
        captureScope();
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === 'clear_activity_log') {
      activityLog = [];
      commandCount = 0;
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
