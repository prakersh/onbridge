import { useState, useEffect, useCallback } from 'react';

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
  lastAction: string;
  activityLog: ActivityEntry[];
  commandCount: number;
  accessScope: AccessScope;
}

const SCOPE_OPTIONS: { value: AccessScope; label: string; desc: string }[] = [
  { value: 'current_tab', label: 'Current Tab', desc: 'Only this tab' },
  { value: 'current_window', label: 'This Window', desc: 'All tabs in window' },
  { value: 'all_tabs', label: 'All Tabs', desc: 'Full browser access' },
];

export default function App() {
  const [status, setStatus] = useState<Status>({
    controlMode: false,
    connected: false,
    lastAction: '',
    activityLog: [],
    commandCount: 0,
    accessScope: 'current_tab',
  });
  const [expandedError, setExpandedError] = useState<number | null>(null);

  const refresh = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'get_status' }, (res: Status) => {
      if (res) setStatus(res);
    });
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 1500);
    return () => clearInterval(interval);
  }, [refresh]);

  const toggle = () => {
    const newMode = !status.controlMode;
    chrome.runtime.sendMessage({ type: 'set_control_mode', enabled: newMode }, () => {
      setStatus((s) => ({ ...s, controlMode: newMode }));
      setTimeout(refresh, 500);
    });
  };

  const setScope = (scope: AccessScope) => {
    chrome.runtime.sendMessage({ type: 'set_scope', scope }, () => {
      setStatus((s) => ({ ...s, accessScope: scope }));
    });
  };

  const clearLog = () => {
    chrome.runtime.sendMessage({ type: 'clear_activity_log' }, () => {
      setStatus((s) => ({ ...s, activityLog: [], commandCount: 0 }));
    });
  };

  const connColor = status.connected
    ? 'text-emerald-400'
    : status.controlMode
      ? 'text-amber-400'
      : 'text-neutral-500';

  const connLabel = status.connected
    ? 'Connected'
    : status.controlMode
      ? 'Connecting...'
      : 'Disconnected';

  const formatTime = (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

  const timeAgo = (ts: number) => {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  };

  return (
    <div className="w-80 bg-neutral-900 text-neutral-100 p-4 font-sans text-sm">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <div className="w-6 h-6 rounded bg-emerald-500/20 flex items-center justify-center">
          <svg viewBox="0 0 128 128" className="w-4 h-4">
            <circle cx="64" cy="52" r="24" fill="none" stroke="#00d4aa" strokeWidth="8" />
            <path d="M48 80 L64 96 L80 80" fill="none" stroke="#00d4aa" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <span className="font-semibold text-base">onbridge</span>
        {status.commandCount > 0 && (
          <span className="ml-auto text-xs text-neutral-500 font-mono">{status.commandCount} cmds</span>
        )}
      </div>

      {/* Access Scope */}
      <div className="mb-3">
        <span className="text-xs text-neutral-400 uppercase tracking-wide font-medium">Access Scope</span>
        <div className="flex gap-1 mt-1.5">
          {SCOPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setScope(opt.value)}
              disabled={status.controlMode}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs text-center transition-colors ${
                status.accessScope === opt.value
                  ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-300'
                  : status.controlMode
                    ? 'bg-neutral-800/50 border border-neutral-800 text-neutral-600 cursor-not-allowed'
                    : 'bg-neutral-800 border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-600'
              }`}
              title={opt.desc}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {status.controlMode && (
          <p className="text-[10px] text-neutral-600 mt-1">Disable control mode to change scope</p>
        )}
      </div>

      {/* Control Mode Toggle */}
      <button
        onClick={toggle}
        className={`w-full rounded-lg p-3 mb-3 flex items-center justify-between transition-colors ${
          status.controlMode
            ? 'bg-emerald-500/20 border border-emerald-500/40'
            : 'bg-neutral-800 border border-neutral-700'
        }`}
      >
        <span className="font-medium">Control Mode</span>
        <div className={`w-10 h-6 rounded-full transition-colors relative ${status.controlMode ? 'bg-emerald-500' : 'bg-neutral-600'}`}>
          <div className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-all ${status.controlMode ? 'left-5' : 'left-1'}`} />
        </div>
      </button>

      {/* Status Row */}
      <div className="flex justify-between text-xs mb-3">
        <div>
          <span className="text-neutral-400">Status: </span>
          <span className={connColor}>{connLabel}</span>
        </div>
        <span className="text-neutral-500 font-mono">:9876</span>
      </div>

      {/* Activity Log */}
      {status.activityLog.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-neutral-400 uppercase tracking-wide">Activity</span>
            <button onClick={clearLog} className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors">Clear</button>
          </div>
          <div className="space-y-1 max-h-52 overflow-y-auto">
            {status.activityLog.map((entry, i) => (
              <div key={`${entry.timestamp}-${i}`}>
                <button
                  onClick={() => entry.error ? setExpandedError(expandedError === i ? null : i) : null}
                  className={`w-full text-left rounded px-2 py-1.5 text-xs flex items-start gap-2 transition-colors ${
                    entry.success ? 'bg-neutral-800/50 hover:bg-neutral-800' : 'bg-red-950/30 hover:bg-red-950/50'
                  }`}
                >
                  <span className={`mt-0.5 flex-shrink-0 ${entry.success ? 'text-emerald-400' : 'text-red-400'}`}>
                    {entry.success ? '✓' : '✗'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono font-medium text-neutral-200">{entry.action}</span>
                      {entry.summary && <span className="text-neutral-500 truncate">{entry.summary}</span>}
                    </div>
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <div className="text-neutral-500 font-mono">{formatTime(entry.timing)}</div>
                    <div className="text-neutral-600" style={{ fontSize: '10px' }}>{timeAgo(entry.timestamp)}</div>
                  </div>
                </button>
                {expandedError === i && entry.error && (
                  <div className="mx-2 mt-1 mb-1 px-2 py-1.5 bg-red-950/40 rounded text-xs text-red-300 break-words">
                    {entry.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {status.connected && status.activityLog.length === 0 && (
        <div className="text-center text-neutral-600 text-xs py-4">Waiting for agent commands...</div>
      )}
    </div>
  );
}
