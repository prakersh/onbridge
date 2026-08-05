/**
 * Inline SVG icon set.
 *
 * Deliberately not emoji: emoji render differently on every platform, cannot be
 * recoloured to match state, do not scale cleanly with the type, and are read
 * aloud by screen readers as prose. These are stroke-based, inherit
 * `currentColor`, and stay legible at 12px where the panel needs them.
 */

interface IconProps {
  className?: string;
}

const base = (className = 'h-3.5 w-3.5') => ({
  className,
  viewBox: '0 0 24 24',
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export function PauseIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

export function PlayIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M6 4l14 8-14 8V4z" />
    </svg>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export function CrossIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export function ClockIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function AlertIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M12 3l9 16H3l9-16z" />
      <path d="M12 10v4M12 17.5v.01" />
    </svg>
  );
}

/** A terminal prompt — the agent, as distinct from the browser. */
export function AgentIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </svg>
  );
}

/** Browser window — used for window-scoped grants. */
export function WindowIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
    </svg>
  );
}

/** A single tab. */
export function TabIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M3 20V8a2 2 0 012-2h4l2-2h3v4h7v12a0 0 0 010 0H3z" />
    </svg>
  );
}

/** Everything — a globe, for browser-wide grants. */
export function GlobeIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18-2.5-2.7-2.5-15.3 0-18z" />
    </svg>
  );
}

/** Closed padlock — the encrypted, paired channel. */
export function LockIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 118 0v3" />
    </svg>
  );
}

/** Paused/held session: a hand, not a pause bar, so the two read differently. */
export function HoldIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M9 11V5.5a1.5 1.5 0 013 0V11" />
      <path d="M12 11V4.5a1.5 1.5 0 013 0V11" />
      <path d="M15 11V6.5a1.5 1.5 0 013 0V13a7 7 0 01-7 7h-1a6 6 0 01-6-6v-3a1.5 1.5 0 013 0" />
    </svg>
  );
}

export function PowerIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M12 3v9" />
      <path d="M18.4 6.6a9 9 0 11-12.8 0" />
    </svg>
  );
}

export function SendIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

export function TrashIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
    </svg>
  );
}

/** onbridge's own mark, used in the panel header. */
export function BridgeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 128 128" className={className} aria-hidden>
      <circle cx="64" cy="52" r="24" fill="none" stroke="currentColor" strokeWidth="8" />
      <path
        d="M48 80 L64 96 L80 80"
        fill="none"
        stroke="currentColor"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Picks the icon that matches a grant's reach. */
export function ScopeIcon({ kind, className }: IconProps & { kind: 'tab' | 'window' | 'all' }) {
  if (kind === 'all') return <GlobeIcon className={className} />;
  if (kind === 'window') return <WindowIcon className={className} />;
  return <TabIcon className={className} />;
}
