import { useState, useEffect, useCallback, useRef } from 'react';

interface ActivityEntry {
  action: string;
  summary: string;
  success: boolean;
  error?: string;
  timing: number;
  timestamp: number;
}

type AccessScope = 'current_tab' | 'current_window' | 'all_tabs';

interface Status {
  controlMode: boolean;
  connected: boolean;
  connectionState: string;
  stateDetail: string;
  paused: boolean;
  degraded: string;
  pairRequest: { agentName: string } | null;
  askRequest: { question: string; options?: string[]; askedAt: number } | null;
  lastAction: string;
  activityLog: ActivityEntry[];
  commandCount: number;
  accessScope: AccessScope;
}

const EMPTY: Status = {
  controlMode: false,
  connected: false,
  connectionState: 'idle',
  stateDetail: '',
  paused: false,
  degraded: '',
  pairRequest: null,
  askRequest: null,
  lastAction: '',
  activityLog: [],
  commandCount: 0,
  accessScope: 'current_tab',
};

const SCOPE_OPTIONS: { value: AccessScope; label: string; desc: string }[] = [
  { value: 'current_tab', label: 'Tab', desc: 'Only the tab that was active when you enabled control' },
  { value: 'current_window', label: 'Window', desc: 'Every tab in this window' },
  { value: 'all_tabs', label: 'All', desc: 'Every tab in every window' },
];

const send = <T,>(msg: Record<string, unknown>): Promise<T> =>
  new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

export default function App() {
  const [status, setStatus] = useState<Status>(EMPTY);
  const [draft, setDraft] = useState('');
  const [sendState, setSendState] = useState<'idle' | 'queued' | 'answered' | 'error'>('idle');
  const [expandedError, setExpandedError] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'get_status' }, (res: Status) => {
      if (res) setStatus(res);
    });
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

  const conn = status.connected
    ? { color: 'bg-emerald-400', label: 'Connected', note: 'encrypted · paired' }
    : status.connectionState === 'pairing'
      ? { color: 'bg-amber-400', label: 'Waiting to pair', note: '' }
      : status.controlMode
        ? { color: 'bg-amber-400 animate-pulse', label: 'Connecting…', note: status.stateDetail }
        : { color: 'bg-neutral-600', label: 'Off', note: '' };

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
        <svg viewBox="0 0 128 128" className="h-5 w-5">
          <circle cx="64" cy="52" r="24" fill="none" stroke="#00d4aa" strokeWidth="8" />
          <path d="M48 80 L64 96 L80 80" fill="none" stroke="#00d4aa" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="font-semibold">onbridge</span>
        <div className="ml-auto flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${conn.color}`} />
          <span className="text-xs text-neutral-400">{conn.label}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* ── Pairing request ── */}
        {status.pairRequest && (
          <div className="m-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-300">
              Pairing request
            </div>
            <p className="mb-3 text-neutral-200">
              <span className="font-medium">{status.pairRequest.agentName}</span> wants to control
              your browser.
            </p>
            <p className="mb-3 text-xs text-neutral-400">
              You only need to approve this once. Afterwards this agent connects silently.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => send({ type: 'resolve_pairing', allow: true }).then(refresh)}
                className="flex-1 rounded-md bg-emerald-500 py-2 font-medium text-neutral-900 transition-colors hover:bg-emerald-400"
              >
                Allow
              </button>
              <button
                onClick={() => send({ type: 'resolve_pairing', allow: false }).then(refresh)}
                className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 py-2 transition-colors hover:bg-neutral-700"
              >
                Deny
              </button>
            </div>
          </div>
        )}

        {/* ── Agent question ── */}
        {status.askRequest && (
          <div className="m-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-300">
              <span className="animate-pulse">●</span> Agent is waiting for you
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
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-orange-300">
              Reduced fidelity
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

        {/* ── Controls ── */}
        <div className="space-y-3 p-3">
          <button
            onClick={() =>
              send({ type: 'set_control_mode', enabled: !status.controlMode }).then(() =>
                setTimeout(refresh, 400),
              )
            }
            className={`flex w-full items-center justify-between rounded-lg border p-3 transition-colors ${
              status.controlMode
                ? 'border-emerald-500/40 bg-emerald-500/15'
                : 'border-neutral-700 bg-neutral-800 hover:bg-neutral-750'
            }`}
          >
            <span className="font-medium">Control Mode</span>
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

          {status.connected && (
            <button
              onClick={() => send({ type: 'set_paused', paused: !status.paused }).then(refresh)}
              className={`w-full rounded-lg border py-2 text-sm font-medium transition-colors ${
                status.paused
                  ? 'border-purple-500/40 bg-purple-500/15 text-purple-200 hover:bg-purple-500/25'
                  : 'border-neutral-700 bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
              }`}
            >
              {status.paused ? '▶  Resume automation' : '⏸  Pause automation'}
            </button>
          )}

          <div>
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
              Access scope
            </div>
            <div className="flex gap-1">
              {SCOPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  title={opt.desc}
                  disabled={status.controlMode}
                  onClick={() => send({ type: 'set_scope', scope: opt.value }).then(refresh)}
                  className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
                    status.accessScope === opt.value
                      ? 'border border-emerald-500/40 bg-emerald-500/20 text-emerald-300'
                      : status.controlMode
                        ? 'cursor-not-allowed border border-neutral-800 bg-neutral-800/50 text-neutral-600'
                        : 'border border-neutral-700 bg-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {status.controlMode && (
              <p className="mt-1 text-[10px] text-neutral-600">
                Turn off Control Mode to change scope
              </p>
            )}
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
                onClick={() => send({ type: 'clear_activity_log' }).then(refresh)}
                className="text-xs text-neutral-500 transition-colors hover:text-neutral-300"
              >
                Clear · {status.commandCount}
              </button>
            )}
          </div>
          {status.activityLog.length === 0 ? (
            <p className="py-6 text-center text-xs text-neutral-600">
              {status.connected ? 'Waiting for the agent…' : 'Not connected'}
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
                    <span className={e.success ? 'text-emerald-400' : 'text-red-400'}>
                      {e.success ? '✓' : '✗'}
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
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[11px] text-neutral-500">
            {sendState === 'answered' && <span className="text-emerald-400">✓ delivered to agent</span>}
            {sendState === 'queued' && (
              <span className="text-amber-400">⏳ queued — arrives on the agent's next action</span>
            )}
            {sendState === 'error' && <span className="text-red-400">✗ not connected</span>}
            {sendState === 'idle' &&
              (status.askRequest
                ? 'The agent is blocked until you reply'
                : 'Enter to send · Shift+Enter for a new line')}
          </span>
          <button
            onClick={() => void submit()}
            disabled={!draft.trim()}
            className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-neutral-900 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
