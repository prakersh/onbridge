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
  askRequest: { question: string; options?: string[]; askedAt: number } | null;
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
  askRequest: null,
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
    (s) => s.status === 'failed' && s.detail && !/^(closed|disconnected|socket error)$/i.test(s.detail),
  );

  const conn = owner
    ? { color: 'bg-emerald-400', label: owner.agent?.name ?? 'Connected' }
    : status.pairRequest
      ? { color: 'bg-amber-400', label: 'Waiting to pair' }
      : status.controlMode
        ? { color: 'bg-amber-400 animate-pulse', label: 'Looking for agents…' }
        : { color: 'bg-neutral-600', label: 'Off' };

  const fmt = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
  const ago = (ts: number) => {
    const d = Math.floor((Date.now() - ts) / 1000);
    if (d < 5) return 'now';
    if (d < 60) return `${d}s`;
    if (d < 3600) return `${Math.floor(d / 60)}m`;
    return `${Math.floor(d / 3600)}h`;
  };

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
              to pair on port {status.pairBlocked.port}, but new agents are only accepted for a
              short window after you turn Control Mode on — so nothing can nag you for access while
              you are not looking. Accept new agents again if you started this one.
            </p>
            <button
              onClick={() => act({ type: 'arm_pairing' })}
              className="w-full rounded-md bg-amber-500 py-2 font-medium text-neutral-900 transition-colors hover:bg-amber-400"
            >
              Accept new agents for 60s
            </button>
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
            {refusals.some((s) => /auth|proof/i.test(s.detail)) ? (
              <p className="mt-2 text-xs text-neutral-400">
                This browser holds a pairing secret that the agent no longer accepts, which means
                its record was replaced since you paired. Another program on your machine can do
                that. Do not re-pair until you know what changed — remove{' '}
                <code className="text-neutral-300">~/.onbridge/peers.json</code> deliberately if you
                want to start over.
              </p>
            ) : (
              <p className="mt-2 text-xs text-neutral-500">
                If you did not expect this, something else on your machine may be holding the
                bridge.
              </p>
            )}
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
