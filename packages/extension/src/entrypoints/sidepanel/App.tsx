import { useState, useEffect, useCallback, useRef } from 'react';
import {
  AgentIcon,
  AlertIcon,
  BridgeIcon,
  CheckIcon,
  ClockIcon,
  CrossIcon,
  HoldIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  PowerIcon,
  ScopeIcon,
  SendIcon,
  TrashIcon,
} from './icons.js';
// Type-only on purpose: the panel never touches the secret store itself. Add
// and delete go through the background worker, and get_status returns records
// that carry no value — so nothing here can render one even by accident.
import type { SecretRecord } from '../../core/secrets.js';

interface ActivityEntry {
  action: string;
  summary: string;
  success: boolean;
  error?: string;
  timing: number;
  timestamp: number;
}

type ScopeKind = 'tab' | 'window' | 'all';
type ApprovalMode = 'yolo' | 'auto' | 'strict';
type SessionStatus = 'connecting' | 'pending_approval' | 'on_hold' | 'active' | 'failed';

interface AgentInfo {
  name: string;
  version?: string;
  source: 'mcp' | 'env' | 'unknown';
  pid: number;
  cwd?: string;
  serverVersion: string;
}

interface SessionView {
  id: string;
  port: number;
  status: SessionStatus;
  detail: string;
  scope: { kind: ScopeKind; tabId?: number; windowId?: number } | null;
  scopeLabel: string | null;
  commandCount: number;
  lastAction: string;
  connectedAt: number;
  ownsThisWindow: boolean;
  agent: AgentInfo | null;
  serverId?: string;
  /**
   * Why the server refused, and what it could prove about its own record.
   *
   * The panel used to state the alarming reading of `invalid auth proof` as
   * fact — "its record was replaced… another program on your machine can do
   * that" — when the commonest cause is a secret left over from an abandoned
   * dev session and the peer file has not been touched in a month. These
   * timestamps are what tells the two apart.
   */
  failure?: {
    reason: string;
    evidence?: {
      pairedAt?: number;
      lastSeen?: number;
      storeWrittenAt?: number;
      siblingServers?: number;
    };
  };
}

const MODES: { value: ApprovalMode; label: string; blurb: string }[] = [
  { value: 'strict', label: 'Ask every step', blurb: 'Approve each navigation and change. Reads still pass.' },
  { value: 'auto', label: 'Balanced', blurb: 'Only credential access and real-world actions are asked.' },
  { value: 'yolo', label: 'Bypass', blurb: 'Nothing is asked. Reverts on its own after 60 minutes.' },
];

const SCOPE_OPTIONS: { value: ScopeKind; label: string; desc: string }[] = [
  { value: 'tab', label: 'Tab', desc: 'Only the tab that is active in this window right now' },
  { value: 'window', label: 'Window', desc: 'Every tab in this window' },
  { value: 'all', label: 'All', desc: 'Every tab in every window' },
];

interface Status {
  controlMode: boolean;
  windowId?: number;
  sessions: SessionView[];
  activeSessionId: string | null;
  connected: boolean;
  anyConnected: boolean;
  preferredScope: ScopeKind;
  paused: boolean;
  degraded: string;
  policy: {
    mode: ApprovalMode;
    allowlist: string[];
    denylist: string[];
    idleRevokeMinutes: number;
  };
  yoloExpiresAt: number;
  approvalRequest: {
    action: string;
    risk: string;
    reason: string;
    detail: string;
    url: string;
    askedAt: number;
  } | null;
  pairRequest: { port: number; wasPaired?: boolean; agent: AgentInfo } | null;
  pairBlocked: { name: string; port: number; at: number } | null;
  /** True while a newly started agent would be offered to the user. */
  pairWindowOpen: boolean;
  askRequest: { question: string; options?: string[]; askedAt: number } | null;
  secrets: SecretRecord[];
  lastAction: string;
  activityLog: ActivityEntry[];
  commandCount: number;
}

const EMPTY: Status = {
  controlMode: false,
  sessions: [],
  activeSessionId: null,
  connected: false,
  anyConnected: false,
  preferredScope: 'window',
  paused: false,
  degraded: '',
  policy: { mode: 'auto', allowlist: [], denylist: [], idleRevokeMinutes: 30 },
  yoloExpiresAt: 0,
  approvalRequest: null,
  pairRequest: null,
  pairBlocked: null,
  pairWindowOpen: false,
  askRequest: null,
  secrets: [],
  lastAction: '',
  activityLog: [],
  commandCount: 0,
};

const send = <T,>(msg: Record<string, unknown>): Promise<T> =>
  new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

const safeHost = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 60);
  }
};

const ago = (ts: number) => {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 5) return 'now';
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  return `${Math.floor(d / 3600)}h`;
};

/** Long paths are unreadable in a 320px panel; the tail is the informative part. */
const shortPath = (p?: string): string => {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
};

export default function App() {
  const [status, setStatus] = useState<Status>(EMPTY);
  const [draft, setDraft] = useState('');
  const [sendState, setSendState] = useState<'idle' | 'queued' | 'answered' | 'error'>('idle');
  const [expandedError, setExpandedError] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const windowIdRef = useRef<number | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Which window this panel belongs to. Everything about "who controls this" is
  // answered relative to it — a panel in another window must show that window's
  // agent, not whichever one happens to be busiest.
  useEffect(() => {
    chrome.windows.getCurrent().then((w) => {
      windowIdRef.current = w.id;
      refresh();
    });
  }, []);

  const refresh = useCallback(() => {
    chrome.runtime.sendMessage(
      { type: 'get_status', windowId: windowIdRef.current },
      (res: Status) => {
        if (res) setStatus(res);
      },
    );
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [refresh]);

  // Focus the composer the moment the agent asks something.
  useEffect(() => {
    if (status.askRequest) inputRef.current?.focus();
  }, [status.askRequest?.askedAt]);

  const act = async (msg: Record<string, unknown>) => {
    const res = await send<{ ok: boolean; reason?: string }>(msg);
    if (res && !res.ok && res.reason) {
      setNotice(res.reason);
      setTimeout(() => setNotice(''), 6000);
    }
    refresh();
    return res;
  };

  const submit = async (textOverride?: string) => {
    const text = (textOverride ?? draft).trim();
    if (!text) return;
    const res = await send<{ ok: boolean; delivered?: string; reason?: string }>({
      type: 'send_user_message',
      text,
    });
    setDraft('');
    if (!res?.ok) setSendState('error');
    else setSendState(res.delivered === 'answered' ? 'answered' : 'queued');
    setTimeout(() => setSendState('idle'), 4000);
    refresh();
  };

  const owner = status.sessions.find((s) => s.ownsThisWindow);
  const others = status.sessions.filter((s) => !s.ownsThisWindow && s.status !== 'failed');

  /**
   * Refusals worth showing, rather than the ordinary churn of probing ten ports.
   *
   * A rejected connection used to land nowhere: the reason was captured and
   * dropped, so an agent locked out of the bridge looked exactly like an agent
   * that was never started. "Another client is already connected" in particular
   * is the one message that distinguishes something else holding the socket from
   * nothing running at all — and that is the case a person most needs to see.
   */
  const refusals = status.sessions.filter(
    (s) =>
      s.status === 'failed' &&
      s.detail &&
      // Ordinary probe churn, not something the user needs to see: a dead port,
      // or a non-onbridge service answering on one of the ports we scan.
      !/^(closed|disconnected|socket error|no onbridge server on this port|handshake timed out)$/i.test(
        s.detail,
      ),
  );

  /** Refusals with a real recovery: the browser's stored secret is not accepted. */
  const authRefusals = refusals.filter((s) => /auth|proof/i.test(s.detail) && s.serverId);

  /**
   * One MCP entry at user scope becomes one server per editor session, and ten
   * of them exhaust the port range — at which point onbridge simply stops
   * working with no error that points at the cause.
   */
  const crowded = status.sessions.length >= 3;

  const conn = owner
    ? { color: 'bg-emerald-400', label: owner.agent?.name ?? 'Connected' }
    : status.pairRequest
      ? { color: 'bg-amber-400', label: 'Waiting to pair' }
      : status.controlMode
        ? { color: 'bg-amber-400 animate-pulse', label: 'Looking for agents…' }
        : { color: 'bg-neutral-600', label: 'Off' };

  const fmt = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

  return (
    <div className="flex h-screen flex-col bg-neutral-900 text-neutral-100 font-sans text-sm">
      {/* ── Header ── */}
      <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3">
        <BridgeIcon className="h-5 w-5 text-emerald-400" />
        <span className="font-semibold">onbridge</span>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <span className={`h-2 w-2 shrink-0 rounded-full ${conn.color}`} />
          <span className="truncate text-xs text-neutral-400">{conn.label}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {notice && (
          <div className="mx-3 mt-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-200">
            <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{notice}</span>
          </div>
        )}

        {/* ── Pairing request ── */}
        {status.pairRequest && (
          <div className="m-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-300">
              Pairing request
            </div>
            <AgentCard agent={status.pairRequest.agent} port={status.pairRequest.port} />
            {status.pairRequest.wasPaired && (
              <div className="mt-2 rounded-md border border-red-500/50 bg-red-500/10 p-2">
                <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-red-300">
                  <AlertIcon className="h-3.5 w-3.5" /> This agent was paired before
                </div>
                <p className="text-xs text-neutral-400">
                  You have already paired with this server, but it no longer recognises this
                  browser — its record was reset. That happens if you cleared{' '}
                  <code className="text-neutral-300">~/.onbridge</code>, and it is also what
                  another program on your machine would have to do to take this agent's place.
                  Only allow this if you know why the record was reset.
                </p>
              </div>
            )}
            <p className="mb-3 mt-2 text-xs text-neutral-400">
              Approve this once and it connects silently from then on. Check the project path
              above matches the session you just started.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => act({ type: 'resolve_pairing', allow: true })}
                className="flex-1 rounded-md bg-emerald-500 py-2 font-medium text-neutral-900 transition-colors hover:bg-emerald-400"
              >
                Allow
              </button>
              <button
                onClick={() => act({ type: 'resolve_pairing', allow: false })}
                className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 py-2 transition-colors hover:bg-neutral-700"
              >
                Deny
              </button>
            </div>
          </div>
        )}

        {/* ── Pairing refused because the window had lapsed ── */}
        {!status.pairRequest && status.pairBlocked && (
          <div className="m-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-300">
              <ClockIcon className="h-3.5 w-3.5" /> A new agent tried to connect
            </div>
            <p className="mb-3 text-xs text-neutral-400">
              <span className="font-medium text-neutral-200">{status.pairBlocked.name}</span> asked
              to pair on port {status.pairBlocked.port} {ago(status.pairBlocked.at)} ago, but new
              agents are only accepted for a short window after you turn Control Mode on — so
              nothing can nag you for access while you are not looking. Accept new agents again if
              you started this one.
            </p>
            <button
              onClick={() => act({ type: 'arm_pairing' })}
              className="w-full rounded-md bg-amber-500 py-2 font-medium text-neutral-900 transition-colors hover:bg-amber-400"
            >
              Accept new agents for 60s
            </button>
          </div>
        )}

        {/* ── The window is open right now ── */}
        {status.pairWindowOpen && !status.pairRequest && (
          <div className="mx-3 mt-3 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-200">
            <ClockIcon className="h-3.5 w-3.5 shrink-0" />
            {/* Whether a new agent would be let in is otherwise invisible, which
                makes "why is my agent not connecting" unanswerable from the panel. */}
            <span>Accepting new agents. A new agent starting now will ask to pair.</span>
          </div>
        )}

        {/* ── A connection the server turned away ── */}
        {refusals.length > 0 && (
          <div className="m-3 rounded-lg border border-red-500/40 bg-red-500/10 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-red-300">
              <AlertIcon className="h-3.5 w-3.5" /> Connection refused
            </div>
            {refusals.map((s) => (
              <p key={s.id} className="mb-1 text-xs text-neutral-400">
                Port {s.port}: <span className="text-neutral-200">{s.detail}</span>
              </p>
            ))}
            {authRefusals.length > 0 ? (
              <AuthRefusalHelp refusals={authRefusals} act={act} />
            ) : (
              <p className="mt-2 text-xs text-neutral-500">
                If you did not expect this, something else on your machine may be holding the
                bridge.
              </p>
            )}
          </div>
        )}

        {/* ── One config line, many servers ── */}
        {crowded && (
          <div className="mx-3 mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-200">
            <div className="mb-1 flex items-center gap-1.5 font-medium">
              <AlertIcon className="h-3.5 w-3.5 shrink-0" /> {status.sessions.length} agents found
            </div>
            <p className="text-neutral-400">
              That usually means onbridge is installed at user scope, so every editor session
              starts its own server. Ten ports are scanned; past that, new agents cannot connect
              at all. Move it to the projects that need it if this was not deliberate.
            </p>
          </div>
        )}

        {/* ── Approval gate ── */}
        {status.approvalRequest && (
          <div className="m-3 rounded-lg border border-red-500/50 bg-red-500/10 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-red-300">
              <AlertIcon className="h-3.5 w-3.5" /> Approval needed
            </div>
            <p className="mb-1 text-neutral-100">
              The agent wants to{' '}
              <span className="font-mono font-medium">{status.approvalRequest.action}</span>
              {status.approvalRequest.detail && (
                <> <span className="text-neutral-300">{status.approvalRequest.detail}</span></>
              )}
            </p>
            {status.approvalRequest.url && (
              <p className="mb-2 truncate text-xs text-neutral-500">
                on {safeHost(status.approvalRequest.url)}
              </p>
            )}
            <p className="mb-3 text-xs text-neutral-400">{status.approvalRequest.reason}.</p>
            <div className="flex gap-2">
              <button
                onClick={() => act({ type: 'resolve_approval', allow: true })}
                className="flex-1 rounded-md bg-red-500 py-2 font-medium text-white transition-colors hover:bg-red-400"
              >
                Allow once
              </button>
              <button
                onClick={() => act({ type: 'resolve_approval', allow: false })}
                className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 py-2 transition-colors hover:bg-neutral-700"
              >
                Deny
              </button>
            </div>
            <p className="mt-2 text-center text-[10px] text-neutral-600">
              Denied automatically if you don't respond.
            </p>
          </div>
        )}

        {/* ── Agent question ── */}
        {status.askRequest && (
          <div className="m-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-300">
              <ClockIcon className="h-3.5 w-3.5" /> Agent is waiting for you
            </div>
            <p className="mb-3 whitespace-pre-wrap text-neutral-100">{status.askRequest.question}</p>
            {status.askRequest.options && status.askRequest.options.length > 0 && (
              <div className="mb-2 flex flex-col gap-1.5">
                {status.askRequest.options.map((opt, i) => (
                  <button
                    key={i}
                    onClick={() => submit(opt)}
                    className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-left transition-colors hover:border-emerald-500/50 hover:bg-neutral-700"
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}
            <p className="text-xs text-neutral-400">Answer below — or type anything else.</p>
          </div>
        )}

        {/* ── Degraded input warning ── */}
        {status.degraded && status.connected && (
          <div className="mx-3 mt-3 rounded-lg border border-orange-500/40 bg-orange-500/10 p-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-orange-300">
              <AlertIcon className="h-3.5 w-3.5" /> Reduced fidelity
            </div>
            <p className="text-xs text-neutral-300">
              onbridge could not attach its debugger, so clicks and typing are being simulated
              instead of sent as real input. Some sites will ignore them.
            </p>
            <p className="mt-1 text-[11px] text-neutral-500">
              Usually because DevTools is open on this tab — only one debugger can attach at a
              time. Close DevTools and reload.
            </p>
          </div>
        )}

        <div className="space-y-3 p-3">
          {/* ── Control mode ── */}
          <button
            onClick={() =>
              send({ type: 'set_control_mode', enabled: !status.controlMode }).then(() =>
                setTimeout(refresh, 400),
              )
            }
            className={`flex w-full items-center justify-between rounded-lg border p-3 transition-colors ${
              status.controlMode
                ? 'border-emerald-500/40 bg-emerald-500/15'
                : 'border-neutral-700 bg-neutral-800 hover:bg-neutral-700'
            }`}
          >
            <span className="flex items-center gap-2 font-medium">
              <PowerIcon
                className={`h-4 w-4 ${status.controlMode ? 'text-emerald-400' : 'text-neutral-500'}`}
              />
              Control Mode
            </span>
            <div
              className={`relative h-6 w-10 rounded-full transition-colors ${
                status.controlMode ? 'bg-emerald-500' : 'bg-neutral-600'
              }`}
            >
              <div
                className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-all ${
                  status.controlMode ? 'left-5' : 'left-1'
                }`}
              />
            </div>
          </button>

          {/* ── This window's agent ── */}
          {status.controlMode && (
            <div>
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
                Controlling this window
              </div>
              {owner ? (
                <SessionCard
                  session={owner}
                  primary
                  onHold={() => act({ type: 'hold_session', id: owner.id })}
                  onDisconnect={() => act({ type: 'disconnect_session', id: owner.id })}
                />
              ) : (
                <p className="rounded-lg border border-dashed border-neutral-700 px-3 py-4 text-center text-xs text-neutral-500">
                  No agent controls this window.
                  {status.sessions.some((s) => s.status === 'on_hold')
                    ? ' Pick one from Waiting below.'
                    : ' Start an agent with onbridge configured and it will appear here.'}
                </p>
              )}
            </div>
          )}

          {/* ── Grant scope ── */}
          {status.controlMode && (
            <div>
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
                Grant on approval
              </div>
              <div className="flex gap-1">
                {SCOPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    title={opt.desc}
                    onClick={() => act({ type: 'set_scope', scope: opt.value })}
                    className={`flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
                      status.preferredScope === opt.value
                        ? 'border border-emerald-500/40 bg-emerald-500/20 text-emerald-300'
                        : 'border border-neutral-700 bg-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                    }`}
                  >
                    <ScopeIcon kind={opt.value} className="h-3 w-3" />
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[10px] text-neutral-600">
                {SCOPE_OPTIONS.find((o) => o.value === status.preferredScope)?.desc}. Applies to
                the next agent you approve; existing grants are unchanged.
              </p>
            </div>
          )}

          {/* ── Other agents ── */}
          {others.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
                <HoldIcon className="h-3.5 w-3.5" />
                Waiting · {others.length}
              </div>
              <div className="space-y-1.5">
                {others.map((s) => (
                  <SessionCard
                    key={s.id}
                    session={s}
                    onActivate={() =>
                      act({
                        type: 'activate_session',
                        id: s.id,
                        windowId: windowIdRef.current,
                        scope: status.preferredScope,
                      })
                    }
                    onDisconnect={() => act({ type: 'disconnect_session', id: s.id })}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ── Pause ── */}
          {owner && (
            <button
              onClick={() => act({ type: 'set_paused', paused: !status.paused })}
              className={`flex w-full items-center justify-center gap-2 rounded-lg border py-2 text-sm font-medium transition-colors ${
                status.paused
                  ? 'border-purple-500/40 bg-purple-500/15 text-purple-200 hover:bg-purple-500/25'
                  : 'border-neutral-700 bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
              }`}
            >
              {status.paused ? <PlayIcon className="h-4 w-4" /> : <PauseIcon className="h-4 w-4" />}
              {status.paused ? 'Resume automation' : 'Pause automation'}
            </button>
          )}

          {/* ── Approval mode ── */}
          <div>
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
              Approvals
            </div>
            <div className="flex gap-1">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  title={m.blurb}
                  onClick={() => act({ type: 'set_approval_mode', mode: m.value })}
                  className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
                    status.policy.mode === m.value
                      ? m.value === 'yolo'
                        ? 'border border-red-500/50 bg-red-500/20 text-red-300'
                        : 'border border-emerald-500/40 bg-emerald-500/20 text-emerald-300'
                      : 'border border-neutral-700 bg-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-neutral-600">
              {MODES.find((m) => m.value === status.policy.mode)?.blurb}
            </p>
          </div>

          {status.policy.mode === 'yolo' && (
            <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-3">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-red-300">
                <AlertIcon className="h-3.5 w-3.5" /> Approvals are off
              </div>
              <p className="text-xs text-neutral-300">
                The agent can read credentials, run scripts, and click things that spend money or
                delete data — without asking you first.
              </p>
              <p className="mt-1 text-[11px] text-neutral-500">
                {status.yoloExpiresAt
                  ? `Reverts to Balanced in ${Math.max(0, Math.round((status.yoloExpiresAt - Date.now()) / 60000))} min, and on browser restart.`
                  : 'Reverts on browser restart.'}
              </p>
              <button
                onClick={() => act({ type: 'set_approval_mode', mode: 'auto' })}
                className="mt-2 w-full rounded-md bg-red-500 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-400"
              >
                Turn approvals back on
              </button>
            </div>
          )}

          {/* ── Domain allowlist ── */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Allowed sites
              </span>
              <span className="text-[10px] text-neutral-600">
                {status.policy.allowlist.length ? 'restricted' : 'any site'}
              </span>
            </div>
            <input
              defaultValue={status.policy.allowlist.join(', ')}
              key={status.policy.allowlist.join(',')}
              placeholder="e.g. github.com, mail.google.com"
              onBlur={(e) =>
                send({
                  type: 'set_policy',
                  policy: {
                    allowlist: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  },
                }).then(refresh)
              }
              className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-xs text-neutral-100 placeholder-neutral-600 outline-none focus:border-emerald-500/50"
            />
            <p className="mt-1 text-[10px] text-neutral-600">
              Leave empty to allow any site. Subdomains are included. Enforced in every approval
              mode, including Bypass.
            </p>
          </div>

          {/* ── Saved secrets ── */}
          <SecretsSection
            secrets={status.secrets ?? EMPTY.secrets}
            windowId={windowIdRef.current}
            act={act}
          />

          {/* ── Pairings ── */}
          <PairingsSection sessions={status.sessions} act={act} />
        </div>

        {/* ── Activity ── */}
        <div className="px-3 pb-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Activity
            </span>
            {status.commandCount > 0 && (
              <button
                onClick={() => act({ type: 'clear_activity_log', id: owner?.id })}
                className="flex items-center gap-1 text-xs text-neutral-500 transition-colors hover:text-neutral-300"
              >
                <TrashIcon className="h-3 w-3" />
                {status.commandCount}
              </button>
            )}
          </div>
          {status.activityLog.length === 0 ? (
            <p className="py-6 text-center text-xs text-neutral-600">
              {owner ? 'Waiting for the agent…' : 'No agent controls this window'}
            </p>
          ) : (
            <div className="space-y-1">
              {status.activityLog.map((e, i) => (
                <div key={`${e.timestamp}-${i}`}>
                  <button
                    onClick={() => e.error && setExpandedError(expandedError === i ? null : i)}
                    className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                      e.success ? 'bg-neutral-800/50 hover:bg-neutral-800' : 'bg-red-950/30 hover:bg-red-950/50'
                    }`}
                  >
                    <span className={`mt-0.5 shrink-0 ${e.success ? 'text-emerald-400' : 'text-red-400'}`}>
                      {e.success ? <CheckIcon className="h-3 w-3" /> : <CrossIcon className="h-3 w-3" />}
                    </span>
                    <span className="flex-1 truncate">
                      <span className="font-mono text-neutral-200">{e.action}</span>{' '}
                      <span className="text-neutral-500">{e.summary}</span>
                    </span>
                    <span className="shrink-0 font-mono text-neutral-600">
                      {fmt(e.timing)} · {ago(e.timestamp)}
                    </span>
                  </button>
                  {expandedError === i && e.error && (
                    <div className="mx-2 mt-1 break-words rounded bg-red-950/40 px-2 py-1.5 text-xs text-red-300">
                      {e.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Composer ── */}
      <div className="border-t border-neutral-800 p-3">
        <textarea
          ref={inputRef}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={status.askRequest ? 'Type your answer…' : 'Send a note to the agent…'}
          className="w-full resize-none rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 outline-none focus:border-emerald-500/50"
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1 text-[11px] text-neutral-500">
            {sendState === 'answered' && (
              <span className="flex items-center gap-1 text-emerald-400">
                <CheckIcon className="h-3 w-3" /> delivered to agent
              </span>
            )}
            {sendState === 'queued' && (
              <span className="flex items-center gap-1 text-amber-400">
                <ClockIcon className="h-3 w-3" /> queued — arrives on next action
              </span>
            )}
            {sendState === 'error' && (
              <span className="flex items-center gap-1 text-red-400">
                <CrossIcon className="h-3 w-3" /> not connected
              </span>
            )}
            {sendState === 'idle' &&
              (status.askRequest
                ? 'The agent is blocked until you reply'
                : 'Enter to send · Shift+Enter for a new line')}
          </span>
          <button
            onClick={() => void submit()}
            disabled={!draft.trim()}
            className="flex shrink-0 items-center gap-1 rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-neutral-900 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            <SendIcon className="h-3 w-3" /> Send
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The identity block. Deliberately shows the project path and pid: with several
 * agents running, the name alone ("Claude Code") identifies none of them.
 */
function AgentCard({ agent, port }: { agent: AgentInfo | null; port: number }) {
  if (!agent) {
    return (
      <div className="flex items-center gap-2 text-neutral-300">
        <AgentIcon className="h-4 w-4 text-neutral-500" />
        <span>Unidentified agent on port {port}</span>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <AgentIcon className="h-4 w-4 shrink-0 text-emerald-400" />
        <span className="truncate font-medium text-neutral-100">{agent.name}</span>
        {agent.version && <span className="shrink-0 text-[10px] text-neutral-500">{agent.version}</span>}
        {/* A name the client reported is worth more than one we inferred. */}
        {agent.source !== 'mcp' && (
          <span
            title="Inferred from the environment — the agent did not identify itself"
            className="shrink-0 rounded bg-neutral-700 px-1 text-[9px] uppercase tracking-wide text-neutral-400"
          >
            guessed
          </span>
        )}
      </div>
      {agent.cwd && (
        <div className="mt-0.5 truncate pl-6 font-mono text-[10px] text-neutral-500" title={agent.cwd}>
          {shortPath(agent.cwd)}
        </div>
      )}
      <div className="mt-0.5 pl-6 font-mono text-[10px] text-neutral-600">
        pid {agent.pid} · port {port} · onbridge {agent.serverVersion}
      </div>
    </div>
  );
}

/**
 * Credentials the agent can use but never read. Only name, origin and age ever
 * reach this component — get_status strips values in the background worker, so
 * there is nothing here a screen-share or a DOM inspector could give away.
 */
function SecretsSection({
  secrets,
  windowId,
  act,
}: {
  secrets: SecretRecord[];
  windowId?: number;
  act: (msg: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string } | undefined>;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [origin, setOrigin] = useState('');

  const startAdd = async () => {
    setAdding(true);
    // Prefill the binding from the page the user is looking at — the common
    // flow is "I am on the login page, save this". Editable, never assumed.
    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab?.url && /^https?:/.test(tab.url)) setOrigin(new URL(tab.url).origin);
    } catch {
      /* no tab access is fine — the field stays blank */
    }
  };

  const save = async () => {
    const res = await act({ type: 'save_secret', name: name.trim(), value, origin: origin.trim() });
    // A refusal (bad name, bad origin) keeps the form so the user can fix it;
    // act() has already surfaced the reason.
    if (res && !res.ok) return;
    setName('');
    setValue('');
    setOrigin('');
    setAdding(false);
  };

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="mb-1.5 flex w-full items-center justify-between"
      >
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
          <LockIcon className="h-3.5 w-3.5" />
          Saved secrets
        </span>
        <span className="text-[10px] text-neutral-600">
          {secrets.length > 0 ? `${secrets.length} · ` : ''}
          {open ? 'hide' : 'show'}
        </span>
      </button>

      {open && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-neutral-600">
            The agent types <code className="text-neutral-400">{'{{secret:name}}'}</code> and the
            real value is filled in here — it never sees or receives it. Each secret only works on
            the site it is saved for.
          </p>

          {secrets.map((s) => (
            <div
              key={s.name}
              className="flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-800/60 px-2.5 py-2 text-xs"
            >
              <LockIcon className="h-3 w-3 shrink-0 text-emerald-400" />
              <span className="shrink-0 font-mono text-neutral-200">{s.name}</span>
              <span className="min-w-0 flex-1 truncate text-neutral-500" title={s.origin}>
                {safeHost(s.origin)}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-neutral-600">
                {ago(s.createdAt)}
              </span>
              <button
                onClick={() => act({ type: 'delete_secret', name: s.name })}
                title={`Delete ${s.name}`}
                className="shrink-0 rounded p-0.5 text-neutral-500 transition-colors hover:text-red-300"
              >
                <TrashIcon className="h-3 w-3" />
              </button>
            </div>
          ))}

          {adding ? (
            <div className="space-y-1.5 rounded-lg border border-neutral-700 bg-neutral-800/60 p-2.5">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="name, e.g. github_password"
                autoFocus
                className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1.5 font-mono text-xs text-neutral-100 placeholder-neutral-600 outline-none focus:border-emerald-500/50"
              />
              <input
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="value"
                autoComplete="new-password"
                className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-xs text-neutral-100 placeholder-neutral-600 outline-none focus:border-emerald-500/50"
              />
              <input
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
                placeholder="site it works on, e.g. https://github.com"
                className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-xs text-neutral-100 placeholder-neutral-600 outline-none focus:border-emerald-500/50"
              />
              <div className="flex gap-1.5 pt-0.5">
                <button
                  onClick={() => void save()}
                  disabled={!name.trim() || !value || !origin.trim()}
                  className="flex-1 rounded-md bg-emerald-500 py-1.5 text-xs font-medium text-neutral-900 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setValue('');
                    setAdding(false);
                  }}
                  className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 py-1.5 text-xs text-neutral-300 transition-colors hover:bg-neutral-700"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => void startAdd()}
              className="w-full rounded-lg border border-dashed border-neutral-700 py-2 text-xs text-neutral-500 transition-colors hover:border-neutral-600 hover:text-neutral-300"
            >
              Add a secret
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The way out of a failed authentication.
 *
 * Two things were wrong here. There was no recovery at all — the handshake
 * dead-ended at `invalid auth proof` and the only exit was hand-editing
 * `~/.onbridge/peers.json`, which is also a trap: removing one entry leaves
 * trust-on-first-use armed and the very extension you are fixing gets refused
 * for a different reason. And the wording asserted a hostile cause as fact,
 * which sent people hunting for an intruder when nothing had touched the file.
 *
 * So: state what the server actually reported, let the person weigh it, and
 * give them a button that clears exactly one pairing.
 */
/**
 * Forgetting pairings from the panel.
 *
 * `clear_pairings` has existed in the background worker since the start with
 * nothing in the UI reaching it, so the documented cure for a broken pairing
 * was to delete a file in `~/.onbridge` by hand. Per-agent comes first because
 * it is almost always the right one; clearing everything is behind a
 * confirmation because it makes every other agent re-prompt.
 */
function PairingsSection({
  sessions,
  act,
}: {
  sessions: SessionView[];
  act: (msg: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string } | undefined>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const pairable = sessions.filter((s) => s.serverId);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="mb-1.5 flex w-full items-center justify-between"
      >
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
          Pairings
        </span>
        <span className="text-[10px] text-neutral-600">{open ? 'hide' : 'show'}</span>
      </button>

      {open && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-neutral-600">
            A pairing is this browser's shared secret with one agent. Forget one and that agent
            has to ask your permission again the next time it connects.
          </p>

          {pairable.length === 0 ? (
            <p className="text-[10px] text-neutral-600">No agents are currently listed.</p>
          ) : (
            pairable.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-800/60 px-2.5 py-2 text-xs"
              >
                <span className="min-w-0 flex-1 truncate text-neutral-300">
                  {s.agent?.name ?? 'Unidentified agent'}{' '}
                  <span className="text-neutral-600">:{s.port}</span>
                </span>
                <button
                  onClick={() => act({ type: 'forget_pairing', id: s.id })}
                  className="shrink-0 rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 transition-colors hover:border-amber-500/50 hover:text-amber-300"
                >
                  Forget
                </button>
              </div>
            ))
          )}

          {confirming ? (
            <div className="space-y-1.5 rounded-lg border border-red-500/40 bg-red-500/10 p-2.5">
              <p className="text-xs text-neutral-300">
                Forget every pairing? Each agent will ask to pair again the next time it connects.
              </p>
              <div className="flex gap-1.5">
                <button
                  onClick={() => {
                    void act({ type: 'clear_pairings' });
                    setConfirming(false);
                  }}
                  className="flex-1 rounded-md bg-red-500 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-400"
                >
                  Forget all
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 py-1.5 text-xs text-neutral-300 transition-colors hover:bg-neutral-700"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="w-full rounded-lg border border-dashed border-neutral-700 py-2 text-xs text-neutral-500 transition-colors hover:border-red-500/40 hover:text-red-300"
            >
              Forget all pairings
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AuthRefusalHelp({
  refusals,
  act,
}: {
  refusals: SessionView[];
  act: (msg: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string } | undefined>;
}) {
  const evidence = refusals.find((s) => s.failure?.evidence)?.failure?.evidence;
  // A record whose file has not been rewritten since it was created was not
  // replaced by anything — which is the fact that settles the question.
  const untouched =
    evidence?.pairedAt != null &&
    evidence.storeWrittenAt != null &&
    Math.abs(evidence.storeWrittenAt - evidence.pairedAt) < 60_000;

  return (
    <div className="mt-2 space-y-2">
      <p className="text-xs text-neutral-400">
        This browser holds a pairing secret that the agent no longer accepts. Either the secret
        here is stale — left over from a session that never completed — or the agent's record was
        replaced, which is also what another program on your machine would have to do to take this
        agent's place.
      </p>

      {evidence && (
        <div className="rounded-md border border-neutral-700 bg-neutral-900/60 p-2 text-[11px] text-neutral-400">
          <div className="mb-1 font-medium text-neutral-300">What the agent reports</div>
          {evidence.pairedAt != null && <div>Paired {ago(evidence.pairedAt)} ago</div>}
          {evidence.lastSeen != null && <div>Last successful auth {ago(evidence.lastSeen)} ago</div>}
          {evidence.storeWrittenAt != null && (
            <div>Its pairing file last written {ago(evidence.storeWrittenAt)} ago</div>
          )}
          {evidence.siblingServers != null && evidence.siblingServers > 1 && (
            <div>{evidence.siblingServers} onbridge servers running on this machine</div>
          )}
          <div className="mt-1 text-neutral-500">
            {untouched
              ? 'Nothing has rewritten that file since the pairing was made, so the record was not replaced — a stale secret here is the likely cause.'
              : 'The file has been written since the pairing was made. That happens when you clear ~/.onbridge, when several agents pair, and also if something enrolled itself.'}
          </div>
        </div>
      )}

      {refusals.map((s) => (
        <button
          key={s.id}
          onClick={() => act({ type: 'forget_pairing', id: s.id })}
          className="w-full rounded-md bg-amber-500 py-2 text-xs font-medium text-neutral-900 transition-colors hover:bg-amber-400"
        >
          Forget the pairing on port {s.port} and pair again
        </button>
      ))}
      <p className="text-[10px] text-neutral-600">
        This clears only this browser's secret for that one agent and asks it to pair again — you
        will be prompted, so nothing reconnects without your say-so. Other agents are untouched.
      </p>
    </div>
  );
}

function SessionCard({
  session,
  primary,
  onActivate,
  onHold,
  onDisconnect,
}: {
  session: SessionView;
  primary?: boolean;
  onActivate?: () => void;
  onHold?: () => void;
  onDisconnect?: () => void;
}) {
  const tone = primary
    ? 'border-emerald-500/40 bg-emerald-500/10'
    : session.status === 'pending_approval'
      ? 'border-amber-500/40 bg-amber-500/10'
      : 'border-neutral-700 bg-neutral-800/60';

  return (
    <div className={`rounded-lg border p-2.5 ${tone}`}>
      <AgentCard agent={session.agent} port={session.port} />

      <div className="mt-2 flex items-center gap-2 pl-6 text-[10px]">
        {session.scope ? (
          <span className="flex items-center gap-1 text-emerald-300">
            <ScopeIcon kind={session.scope.kind} className="h-3 w-3" />
            {session.scopeLabel}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-neutral-500">
            <HoldIcon className="h-3 w-3" />
            {session.status === 'pending_approval' ? 'awaiting pairing' : 'no control granted'}
          </span>
        )}
        {primary && (
          <span className="flex items-center gap-1 text-neutral-500">
            <LockIcon className="h-3 w-3" /> encrypted
          </span>
        )}
        {session.commandCount > 0 && (
          <span className="ml-auto font-mono text-neutral-600">{session.commandCount} cmds</span>
        )}
      </div>

      <div className="mt-2 flex gap-1.5 pl-6">
        {onActivate && session.status !== 'pending_approval' && (
          <button
            onClick={onActivate}
            className="flex-1 rounded-md bg-emerald-500 py-1 text-xs font-medium text-neutral-900 transition-colors hover:bg-emerald-400"
          >
            Give this agent control
          </button>
        )}
        {onHold && (
          <button
            onClick={onHold}
            className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 py-1 text-xs text-neutral-300 transition-colors hover:bg-neutral-700"
          >
            Release
          </button>
        )}
        {onDisconnect && (
          <button
            onClick={onDisconnect}
            title="Disconnect this agent"
            className="rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1 text-neutral-400 transition-colors hover:border-red-500/50 hover:text-red-300"
          >
            <CrossIcon className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}
