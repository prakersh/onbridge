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

import type { AgentIdentity, ExtensionMessage, ServerMessage } from '@onbridge/shared';
import { WS_PORT_RANGE } from '@onbridge/shared';
import { SecureClient, type ClientState } from './secure-client.js';

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
  /** The server's stable id. Survives `npx` respawns, so pairing survives too. */
  id: string;
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
  onPairRequest: (agent: AgentIdentity, port: number) => Promise<boolean>;
  /** A command arrived from an agent that currently holds territory. */
  onCommand: (session: AgentSession, msg: ServerMessage) => void;
  /** Anything the panel should redraw for. */
  onChange: () => void;
  log: (msg: string) => void;
}

/** How often we look for agents that started after we did. */
const SWEEP_INTERVAL_MS = 10_000;
/** Ports that just refused us are skipped for this long. */
const RETRY_BACKOFF_MS = 20_000;

export class ConnectionManager {
  private entries = new Map<number, Entry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private hooks: ManagerHooks) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const e of this.entries.values()) e.client.disconnect();
    this.entries.clear();
    this.hooks.onChange();
  }

  isRunning(): boolean {
    return this.running;
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

    await Promise.all(
      WS_PORT_RANGE.map(async (port) => {
        const existing = this.entries.get(port);
        if (existing) {
          if (existing.busy) return;
          // A live or user-visible session owns this port; leave it be.
          if (existing.session.status !== 'failed') return;
          if (now < existing.retryAfter) return;
        }
        await this.dial(port);
      }),
    );
  }

  private async dial(port: number): Promise<void> {
    const prior = this.entries.get(port);
    prior?.client.disconnect();

    const session: AgentSession = {
      id: prior?.session.id ?? `port:${port}`,
      port,
      identity: prior?.session.identity,
      status: 'connecting',
      detail: '',
      // Territory is never inherited across a reconnect by default; the one
      // exception is a session that was active, which we restore below so a
      // server restart does not make the user re-grant a window.
      scope: prior?.session.scope ?? null,
      connectedAt: Date.now(),
      commandCount: prior?.session.commandCount ?? 0,
      lastAction: '',
      activityLog: prior?.session.activityLog ?? [],
      attempts: (prior?.session.attempts ?? 0) + 1,
    };

    const client = new SecureClient(port, {
      onPairRequest: (agent) => {
        session.status = 'pending_approval';
        session.identity = agent;
        this.hooks.onChange();
        return this.hooks.onPairRequest(agent, port);
      },
      onIdentity: (agent) => {
        session.identity = agent;
        if (session.id.startsWith('port:')) session.id = client.getServerId() || session.id;
        this.hooks.onChange();
      },
      onMessage: (msg) => {
        // Territory is checked here, at the door. A session on hold is fully
        // authenticated but owns nothing, so it must not execute anything.
        if (session.status !== 'active' || !session.scope) {
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
      if (serverId) session.id = serverId;

      // A session that already had territory keeps it across a reconnect —
      // `npx` respawns servers constantly and re-granting a window every time
      // would be intolerable. Anything else waits for the user.
      session.status = session.scope ? 'active' : 'on_hold';
      session.detail = '';
      this.hooks.log(
        `agent on :${port} ${session.status} — ${session.identity?.name ?? 'unidentified'}`,
      );
    } catch (err) {
      entry.busy = false;
      const why = (err as Error).message;
      session.status = 'failed';
      session.detail = why;
      entry.retryAfter = Date.now() + RETRY_BACKOFF_MS;
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
    const why =
      session.status === 'pending_approval'
        ? 'Waiting for the user to approve this agent in the onbridge side panel.'
        : 'This agent is connected but has not been given control of a tab or window. ' +
          'Ask the user to open the onbridge side panel in the window they want you to ' +
          'drive and press "Give this agent control".';
    void client.send({
      type: 'result',
      id: msg.id,
      success: false,
      data: null,
      error: why,
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
    if (entry.session.status === 'failed') {
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
