/**
 * Discovers every onbridge agent on the loopback range and keeps them apart.
 *
 * The old model was one socket, one agent, one browser. That falls over as soon
 * as you run two Claude Code sessions on two projects: they race for the same
 * port scan, one silently loses, and neither user can tell which is which.
 *
 * The model here instead:
 *
 *   - Each agent process binds its own port, so a port *is* an agent.
 *   - We probe all ports in parallel and hold every agent we find.
 *   - An agent controls nothing until the user gives it territory — a tab, a
 *     window, or the whole browser. That grant is what `activate()` does.
 *   - Two agents may run at once as long as their territories do not overlap,
 *     which is what makes "this window is Claude A, that window is Claude B"
 *     work.
 *
 * Holding rather than auto-connecting is deliberate. An agent that connects the
 * instant it starts, to whatever window happens to be focused, is how you end up
 * with the wrong session driving the window you were reading.
 */

import type {
  AgentIdentity,
  ExtensionMessage,
  PairingEvidence,
  ServerMessage,
} from '@onbridge/shared';
import { WS_PORT_RANGE } from '@onbridge/shared';
import {
  SecureClient,
  forgetPairing as forgetStoredPairing,
  type ClientState,
} from './secure-client.js';

export type SessionStatus =
  /** Handshake in flight. */
  | 'connecting'
  /** Waiting on the user to approve pairing (first contact with this agent). */
  | 'pending_approval'
  /** Authenticated, but the user has not given it anything to control. */
  | 'on_hold'
  /** Live and driving its scope. */
  | 'active'
  | 'failed';

/** What a session is allowed to touch. Assigned when the user activates it. */
export interface SessionScope {
  kind: 'tab' | 'window' | 'all';
  tabId?: number;
  windowId?: number;
}

export interface ActivityEntry {
  action: string;
  summary: string;
  success: boolean;
  error?: string;
  timing: number;
  timestamp: number;
}

export interface AgentSession {
  /**
   * Routing and display handle, keyed to the port. A port hosts exactly one
   * server process at a time, so this is the per-instance identity — which the
   * machine-wide `serverId` is NOT: that is one value for every process under a
   * given `~/.onbridge`, so using it here collapsed two live agents (or a live
   * agent and a dead twin on a recycled port) onto one entry, and every id-keyed
   * lookup then routed to whichever was found first. See `serverId` for the
   * pairing key.
   */
  id: string;
  /**
   * The server's stable, machine-wide id from `hello_ack`. Survives `npx`
   * respawns and is the key pairing is stored under — but it does NOT identify a
   * live instance, so it is kept for reference only, never used for routing.
   */
  serverId?: string;
  port: number;
  identity?: AgentIdentity;
  status: SessionStatus;
  detail: string;
  scope: SessionScope | null;
  connectedAt: number;
  commandCount: number;
  lastAction: string;
  activityLog: ActivityEntry[];
  /**
   * How many times we have dialled this port. A clean first pairing is 1; a
   * climbing count means the handshake is being abandoned and retried, which is
   * what the pairing-prompt timeout regression looked like from outside.
   */
  attempts: number;
  /**
   * Why the server refused, with whatever it could prove about its own record.
   *
   * Carried so the panel can offer a real way out of a failed authentication
   * instead of telling the user to edit JSON, and so it can report what is
   * actually known rather than asserting the alarming reading of an ambiguous
   * symptom.
   */
  failure?: { reason: string; evidence?: PairingEvidence };
}

interface Entry {
  client: SecureClient;
  session: AgentSession;
  /** Set while a probe is in flight so the sweep does not double-dial a port. */
  busy: boolean;
  /** Backoff for ports that just failed, so a dead port is not hammered. */
  retryAfter: number;
}

export interface ManagerHooks {
  /** Ask the user to approve first contact with this agent. */
  onPairRequest: (agent: AgentIdentity, port: number, opts: { wasPaired: boolean }) => Promise<boolean>;
  /**
   * A pairing prompt for this port is no longer answerable — its session died
   * before the user responded. Lets the panel dismiss a prompt for a peer that
   * has gone, instead of leaving Allow/Deny on screen for a dead socket.
   */
  onPairObsolete?: (port: number) => void;
  /** A command arrived from an agent that currently holds territory. */
  onCommand: (session: AgentSession, msg: ServerMessage) => void;
  /** Anything the panel should redraw for. */
  onChange: () => void;
  /** A session got its territory back on reconnect, without the user pressing anything. The server has to hear about it the same way as a fresh grant. */
  onGranted?: (id: string) => void;
  /** A session finished its handshake and is authenticated, held or restored. */
  onConnected?: (session: AgentSession) => void;
  log: (msg: string) => void;
}

/**
 * Where a test harness moves the scanned range: set from the extension's own pages, which nothing outside the extension can write to. Test servers listen elsewhere too (`ONBRIDGE_PORT_BASE`), so a test browser never reaches a user's real agents and a user's browser never reaches a test's. Test browsers share the published extension id, so without this a test profile probed every real agent on the machine.
 */
export const PORT_BASE_KEY = 'onbridge_port_base';

async function scannedPorts(): Promise<readonly number[]> {
  const raw: unknown = (await chrome.storage.local.get(PORT_BASE_KEY))[PORT_BASE_KEY];
  const base = typeof raw === 'number' ? raw : NaN;
  if (!Number.isInteger(base) || base < 1024 || base + WS_PORT_RANGE.length - 1 > 65535) return WS_PORT_RANGE;
  return WS_PORT_RANGE.map((_, i) => base + i);
}

/**
 * Whether anything is listening on a loopback port, found out without a WebSocket.
 *
 * Chrome logs every failed WebSocket connection as an error the extension cannot catch, and with most of the ten ports empty, dialling each one every sweep filled chrome://extensions with "ERR_CONNECTION_REFUSED". A failed plain request logs nothing. Any onbridge server, old or new, answers it with 426 Upgrade Required, so any response at all means it is worth dialling.
 */
async function somethingListens(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/** How often we look for agents that started after we did. */
const SWEEP_INTERVAL_MS = 10_000;
/** Wakes a suspended service worker to keep discovering agents. */
const SWEEP_ALARM = 'onbridge-sweep';
/** Ports that just refused us are skipped for this long. */
const RETRY_BACKOFF_MS = 20_000;
/**
 * A pairing the user explicitly denied is not retried for this long — far past
 * the server's 60s pairing window, so the sweep cannot make the server re-offer
 * and re-prompt for an agent that was just refused.
 */
const DENY_BACKOFF_MS = 5 * 60_000;

export class ConnectionManager {
  private entries = new Map<number, Entry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** Bound once so it can be removed again in `stop()`. */
  private onAlarm = (alarm: chrome.alarms.Alarm): void => {
    if (alarm.name === SWEEP_ALARM) void this.sweep();
  };

  constructor(private hooks: ManagerHooks) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    // The interval above dies with the MV3 service worker, which is suspended
    // whenever no socket holds it open — exactly the state we are in while
    // looking for an agent. The alarm survives suspension and wakes the worker,
    // so an agent started on a quiet browser is still discovered. One minute is
    // the floor Chrome enforces for alarms; the interval keeps discovery brisk
    // while the worker happens to be alive.
    // 30s, the shortest period Chrome allows. It is the only sweep that runs while the worker is suspended, which is the state a browser is in when no agent is connected, and an agent's first tool call is waiting on it.
    chrome.alarms?.create(SWEEP_ALARM, { periodInMinutes: 0.5 });
    chrome.alarms?.onAlarm.addListener(this.onAlarm);
  }

  stop(): void {
    this.running = false;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    chrome.alarms?.clear(SWEEP_ALARM);
    chrome.alarms?.onAlarm.removeListener(this.onAlarm);
    for (const e of this.entries.values()) e.client.disconnect();
    this.entries.clear();
    this.hooks.onChange();
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Drops every backoff and re-probes immediately.
   *
   * Called when the user re-opens the pairing window. A refusal — whether the
   * user denied it or the window had lapsed — parks that port on a long backoff
   * so the sweep cannot nag them again. Re-arming is the explicit "yes, I do
   * want an agent now", so it has to clear that, or the agent the user just
   * invited would not be offered again for minutes.
   */
  rearm(): void {
    for (const entry of this.entries.values()) entry.retryAfter = 0;
    void this.sweep();
  }

  /** Every known agent, newest connection last. */
  list(): AgentSession[] {
    return [...this.entries.values()]
      .map((e) => e.session)
      .sort((a, b) => a.connectedAt - b.connectedAt);
  }

  get(id: string): AgentSession | undefined {
    return this.list().find((s) => s.id === id);
  }

  /**
   * Probes every port that is not already held by a live session.
   *
   * Parallel on purpose: the old sequential scan meant a slow or occupied early
   * port delayed everything behind it, and each probe's failure was a visible
   * connect/disconnect. Ten simultaneous loopback dials cost nothing — a dead
   * port refuses instantly.
   */
  private async sweep(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();
    const ports = await scannedPorts();

    await Promise.all(
      ports.map(async (port) => {
        const existing = this.entries.get(port);
        if (existing) {
          if (existing.busy) return;
          // A live or user-visible session owns this port; leave it be.
          if (existing.session.status !== 'failed') return;
          if (now < existing.retryAfter) return;
        }
        if (!(await somethingListens(port))) {
          // The agent that was here has gone; a failed entry for it is history, not state.
          if (existing) {
            this.entries.delete(port);
            this.hooks.onChange();
          }
          return;
        }
        await this.dial(port);
      }),
    );
  }

  private async dial(port: number): Promise<void> {
    const prior = this.entries.get(port);
    prior?.client.disconnect();

    const priorScope = prior?.session.scope ?? null;
    const priorServerId = prior?.session.serverId;

    const session: AgentSession = {
      id: `port:${port}`,
      serverId: priorServerId,
      port,
      identity: prior?.session.identity,
      status: 'connecting',
      detail: '',
      // Territory is never inherited implicitly. It is restored below only when
      // the very same server process reconnects and nothing else has claimed an
      // overlapping scope in the meantime — otherwise the session waits for the
      // user. Carrying it in unconditionally let a different agent that took a
      // recycled port inherit the previous agent's window.
      scope: null,
      connectedAt: Date.now(),
      commandCount: prior?.session.commandCount ?? 0,
      lastAction: '',
      activityLog: prior?.session.activityLog ?? [],
      attempts: (prior?.session.attempts ?? 0) + 1,
    };

    const client = new SecureClient(port, {
      onPairRequest: (agent, opts) => {
        session.status = 'pending_approval';
        session.identity = agent;
        this.hooks.onChange();
        return this.hooks.onPairRequest(agent, port, opts);
      },
      onIdentity: (agent) => {
        session.identity = agent;
        session.serverId = client.getServerId() || session.serverId;
        this.hooks.onChange();
      },
      onMessage: (msg) => {
        // Territory is checked here, at the door. A session on hold is fully
        // authenticated but owns nothing, so it must not execute anything.
        if (session.status !== 'active' || !session.scope) {
          // bridge_status is how an agent finds out it has no control yet, and it reads nothing from any page, so an authenticated agent may ask it before a grant.
          if (msg.type === 'command' && msg.action === 'bridge_status' && session.status === 'on_hold') {
            this.hooks.onCommand(session, msg);
            return;
          }
          if (msg.type === 'command') this.refuse(client, session, msg);
          return;
        }
        this.hooks.onCommand(session, msg);
      },
      onState: (state, detail) => this.onClientState(port, session, client, state, detail),
    });

    const entry: Entry = { client, session, busy: true, retryAfter: 0 };
    this.entries.set(port, entry);

    try {
      await client.connect();
      entry.busy = false;
      const serverId = client.getServerId();
      session.serverId = serverId || session.serverId;

      const verdict = decideRestore(
        priorScope,
        priorServerId,
        serverId,
        this.list().filter((s) => s.id !== session.id),
      );
      if (verdict.restore) {
        session.scope = priorScope;
        session.status = 'active';
        session.detail = '';
        this.hooks.onGranted?.(session.id);
      } else {
        session.status = 'on_hold';
        session.detail = verdict.reason;
      }
      this.hooks.log(
        `agent on :${port} ${session.status} — ${session.identity?.name ?? 'unidentified'}`,
      );
      this.hooks.onConnected?.(session);
    } catch (err) {
      entry.busy = false;
      // Retire the dead client so a late callback cannot resurrect this entry.
      client.disconnect();
      // A prompt awaiting the user is now unanswerable — dismiss it.
      if (session.status === 'pending_approval') this.hooks.onPairObsolete?.(port);
      const why = (err as Error).message;
      // Paired in another browser is the user's choice made elsewhere: treated like a denial, so this browser does not re-prompt for it; "Accept new agents" (arm_pairing) clears it.
      const denied = /pairing denied|paired in another browser/i.test(why);
      session.status = 'failed';
      session.detail = why;
      session.failure = client.getFailure() ?? { reason: why };
      // A denial is sticky: without a long backoff the sweep redials within ~20s,
      // the server re-offers while still inside its 60s pairing window, and the
      // user is re-prompted for an agent they just refused. The panel hides the
      // ordinary probe churn (see the refusal filter), so a lingering failed
      // entry is invisible; it exists only so the sweep can reconnect if a
      // server reappears on this port.
      // Nothing listening is not backed off: the next sweep simply looks again. Servers now start listening on their agent's first tool call, and that call is waiting for the browser, so a port found empty moments earlier must be retried on the next sweep rather than 20s later. Probing a closed loopback port costs nothing.
      const nothingThere = /^(no onbridge server on this port|closed|socket error)$/i.test(why);
      entry.retryAfter = nothingThere ? 0 : Date.now() + (denied ? DENY_BACKOFF_MS : RETRY_BACKOFF_MS);
      // Nothing listening is the overwhelmingly common case across ten ports;
      // logging it every sweep would bury everything else.
      if (!/no onbridge server|closed|socket error/i.test(why)) {
        this.hooks.log(`agent on :${port} failed — ${why}`);
      }
    }
    this.hooks.onChange();
  }

  private onClientState(
    port: number,
    session: AgentSession,
    client: SecureClient,
    state: ClientState,
    detail?: string,
  ): void {
    const entry = this.entries.get(port);
    // A client the manager has already replaced must not touch current state.
    if (!entry || entry.client !== client) return;

    if (state === 'pairing') session.status = 'pending_approval';
    else if (state === 'idle' || state === 'failed') {
      if (session.status !== 'failed') {
        if (session.status === 'pending_approval') this.hooks.onPairObsolete?.(port);
        session.status = 'failed';
        session.detail = detail ?? 'disconnected';
        // Reconnect is the sweep's job. Scheduling one here as well is what
        // produced overlapping reconnect chains, each spawning more.
        entry.retryAfter = Date.now() + RETRY_BACKOFF_MS / 4;
      }
    }
    this.hooks.onChange();
  }

  private refuse(client: SecureClient, session: AgentSession, msg: ServerMessage): void {
    if (msg.type !== 'command') return;
    const code = session.identity?.code;
    const which = code ? ` on the card showing connection code ${code}` : '';
    const why =
      session.status === 'pending_approval'
        ? `Waiting for the user to approve this agent in the onbridge side panel${code ? ` (the request showing connection code ${code})` : ''}.`
        : 'This agent is connected but has not been given control of a tab or window. ' +
          'Ask the user to open the onbridge side panel in the window they want you to ' +
          `drive and press "Give this agent control"${which}.`;
    void client.send({
      type: 'result',
      id: msg.id,
      success: false,
      data: null,
      error: why,
      // Composed here, not by any page: the agent is told it is onbridge speaking, instead of seeing it fenced as page text.
      errorKind: 'trusted',
      timing: 0,
    });
  }

  /**
   * Grants a session territory. Refuses overlaps rather than silently letting
   * two agents fight over one window — a conflict the user cannot see is worse
   * than an error they can.
   */
  activate(id: string, scope: SessionScope): { ok: boolean; reason?: string } {
    const entry = [...this.entries.values()].find((e) => e.session.id === id);
    if (!entry) return { ok: false, reason: 'That agent is no longer connected.' };
    if (entry.session.status === 'pending_approval') {
      return { ok: false, reason: 'Approve the pairing request first.' };
    }
    // Only a fully-authenticated session may be granted control. A 'connecting'
    // one has not finished mutual auth, so granting it territory would let a
    // scope land before the handshake proves who is on the other end.
    if (entry.session.status !== 'on_hold' && entry.session.status !== 'active') {
      return { ok: false, reason: 'That agent is not connected.' };
    }

    const clash = this.list().find(
      (s) => s.id !== id && s.status === 'active' && s.scope && overlaps(s.scope, scope),
    );
    if (clash) {
      return {
        ok: false,
        reason:
          `${clash.identity?.name ?? 'Another agent'} already controls ` +
          `${describeScope(clash.scope!)}. Release it first, or give this agent a different window.`,
      };
    }

    entry.session.scope = scope;
    entry.session.status = 'active';
    this.hooks.onChange();
    return { ok: true };
  }

  /** Revokes territory but keeps the connection, so it can be handed back. */
  hold(id: string): void {
    const entry = [...this.entries.values()].find((e) => e.session.id === id);
    if (!entry) return;
    entry.session.scope = null;
    if (entry.session.status === 'active') entry.session.status = 'on_hold';
    this.hooks.onChange();
  }

  /**
   * Forgets this browser's stored secret for one agent and redials it.
   *
   * The way out of the dead end. When the browser holds a secret the server no
   * longer accepts, the handshake fails at `invalid auth proof` and nothing in
   * the protocol recovers: the extension keeps offering a secret the server
   * will keep rejecting. Dropping just this one puts the next handshake on the
   * `pair_reset` path — the server drops its record and the user is asked to
   * approve a fresh pairing — which is a path that already exists and already
   * requires consent. Every other pairing is left untouched.
   */
  async forgetPairing(id: string): Promise<{ ok: boolean; reason?: string }> {
    const entry = [...this.entries.values()].find((e) => e.session.id === id);
    if (!entry) return { ok: false, reason: 'That agent is no longer listed.' };

    const serverId = entry.session.serverId;
    if (!serverId) {
      return {
        ok: false,
        reason: 'That agent never got far enough to identify itself, so there is nothing stored to forget.',
      };
    }

    const removed = await forgetStoredPairing(serverId);
    entry.client.disconnect();
    entry.session.status = 'failed';
    entry.session.detail = removed
      ? 'Pairing forgotten. Reconnecting — approve it when it asks.'
      : 'No stored pairing for this agent. Reconnecting.';
    entry.session.failure = undefined;
    // Clear the backoff: the user just asked for this one specifically.
    entry.retryAfter = 0;
    this.hooks.onChange();
    void this.sweep();
    return { ok: true };
  }

  /** Drops the connection entirely. The sweep will rediscover it as on-hold. */
  disconnect(id: string): void {
    const found = [...this.entries.entries()].find(([, e]) => e.session.id === id);
    if (!found) return;
    const [port, entry] = found;
    entry.client.disconnect();
    this.entries.delete(port);
    this.hooks.onChange();
  }

  /** The session controlling a given window, if any. Used by the side panel. */
  sessionForWindow(windowId: number): AgentSession | undefined {
    const live = this.list().filter((s) => s.status === 'active' && s.scope);
    // A window-specific grant beats a browser-wide one, so a user who scoped an
    // agent to this window sees that agent rather than the global one.
    return (
      live.find((s) => s.scope!.kind === 'window' && s.scope!.windowId === windowId) ??
      live.find((s) => s.scope!.kind === 'tab' && s.scope!.windowId === windowId) ??
      live.find((s) => s.scope!.kind === 'all')
    );
  }

  /** The session that owns a tab, which is who a command for it must come from. */
  sessionForTab(tabId: number, windowId: number): AgentSession | undefined {
    const live = this.list().filter((s) => s.status === 'active' && s.scope);
    return (
      live.find((s) => s.scope!.kind === 'tab' && s.scope!.tabId === tabId) ??
      live.find((s) => s.scope!.kind === 'window' && s.scope!.windowId === windowId) ??
      live.find((s) => s.scope!.kind === 'all')
    );
  }

  async send(id: string, msg: ExtensionMessage): Promise<void> {
    const entry = [...this.entries.values()].find((e) => e.session.id === id);
    await entry?.client.send(msg);
  }

  /** Broadcasts to every session with territory — used for user notes. */
  async broadcastActive(msg: ExtensionMessage): Promise<void> {
    await Promise.all(
      [...this.entries.values()]
        .filter((e) => e.session.status === 'active')
        .map((e) => e.client.send(msg)),
    );
  }

  hasActive(): boolean {
    return this.list().some((s) => s.status === 'active');
  }
}

/**
 * Whether a reconnecting session may take back the territory it held.
 *
 * Two conditions, both load-bearing. The server must be the *same process* —
 * `npx` respawns constantly and re-granting a window every time would be
 * intolerable, but a port is recycled the moment its owner exits, so matching on
 * port alone handed a brand-new agent the previous one's window. And nothing may
 * have been granted an overlapping scope while it was away: a failed session
 * keeps its scope, and `activate()` only compares against *active* ones, so the
 * user could hand that window to someone else and have the original silently
 * reclaim it on reconnect — two agents driving one window.
 */
export function decideRestore(
  priorScope: SessionScope | null,
  priorServerId: string | undefined,
  serverId: string,
  others: AgentSession[],
): { restore: boolean; reason: string } {
  if (!priorScope) return { restore: false, reason: '' };

  if (!serverId || priorServerId !== serverId) {
    return {
      restore: false,
      reason:
        'A different agent now answers on this port. Grant control again if you want it to drive.',
    };
  }

  const clash = others.find((s) => s.status === 'active' && s.scope && overlaps(s.scope, priorScope));
  if (clash) {
    return {
      restore: false,
      reason:
        `${clash.identity?.name ?? 'Another agent'} now controls that scope. ` +
        'Grant control again to reassign.',
    };
  }

  return { restore: true, reason: '' };
}

/** Two grants overlap when either could reach the same tab. */
export function overlaps(a: SessionScope, b: SessionScope): boolean {
  if (a.kind === 'all' || b.kind === 'all') return true;
  if (a.kind === 'window' && b.kind === 'window') return a.windowId === b.windowId;
  if (a.kind === 'tab' && b.kind === 'tab') return a.tabId === b.tabId;
  // One window-wide, one single tab: they collide only if the tab is in it.
  const win = a.kind === 'window' ? a : b;
  const tab = a.kind === 'tab' ? a : b;
  return win.windowId === tab.windowId;
}

export function describeScope(scope: SessionScope): string {
  if (scope.kind === 'all') return 'the whole browser';
  if (scope.kind === 'window') return 'this window';
  return 'a single tab';
}

/** True when `tabId` falls inside the session's grant. */
export function scopeAllows(scope: SessionScope, tabId: number, windowId: number): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'window') return scope.windowId === windowId;
  return scope.tabId === tabId;
}
