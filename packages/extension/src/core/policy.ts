/**
 * Risk classification and domain policy.
 *
 * Enforced in the extension on purpose: the extension is the real trust
 * boundary. Anything checked only on the server side is advice, since whatever
 * reaches the socket has already decided to behave or not.
 */

export type RiskClass = 'read' | 'navigate' | 'write' | 'sensitive' | 'destructive';

const READ = new Set([
  'snapshot', 'find', 'get_text', 'get_url', 'screenshot', 'dom_query',
  'list_tabs', 'console_logs', 'activity_log', 'list_downloads', 'wait',
  'bridge_status', 'ask_user',
]);

const NAVIGATE = new Set(['navigate', 'back', 'forward', 'reload', 'new_tab', 'switch_tab', 'close_tab']);

/**
 * Actions that can exfiltrate credentials or run arbitrary code. These are the
 * primitives a prompt-injected agent would reach for, so they are gated by
 * default however innocuous the immediate call looks.
 */
const SENSITIVE = new Set(['get_cookies', 'set_cookie', 'evaluate', 'upload', 'download_file']);

const WRITE = new Set([
  'click', 'click_by_text', 'type', 'fill_form', 'select', 'hover', 'scroll',
  'press_key', 'drag', 'dismiss_modal',
]);

/**
 * Text on a control that suggests the click spends money, sends something, or
 * destroys something. Deliberately broad: a false prompt costs one click, a
 * false negative costs a real-world action the user never sanctioned.
 */
export const DESTRUCTIVE_TEXT =
  /\b(buy|purchase|pay|payment|checkout|place\s+order|order\s+now|subscribe|confirm|delete|remove|discard|destroy|terminate|cancel\s+(subscription|account)|send|submit|transfer|withdraw|deposit|book\s+now|reserve|sign\s+contract|accept\s+(offer|terms)|publish|deploy|merge|approve)\b/i;

export function classify(action: string, labelText?: string): RiskClass {
  if (SENSITIVE.has(action)) return 'sensitive';
  if (READ.has(action)) return 'read';
  if (NAVIGATE.has(action)) return 'navigate';
  if (WRITE.has(action)) {
    if (labelText && DESTRUCTIVE_TEXT.test(labelText)) return 'destructive';
    return 'write';
  }
  // Unknown actions are treated as writes rather than reads: an action added
  // later should fail towards caution, not towards silent permission.
  return 'write';
}

export interface Policy {
  /** Empty means "any domain". Entries are hostname suffixes. */
  allowlist: string[];
  denylist: string[];
  /** Which classes require an explicit user approval. */
  requireApproval: RiskClass[];
  /** Minutes of inactivity after which control mode revokes itself. 0 = never. */
  idleRevokeMinutes: number;
}

export const DEFAULT_POLICY: Policy = {
  allowlist: [],
  denylist: [],
  requireApproval: ['sensitive', 'destructive'],
  idleRevokeMinutes: 30,
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Suffix match on labels, so "example.com" covers "app.example.com". */
function matchesDomain(host: string, patterns: string[]): boolean {
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase().replace(/^\*\./, '');
    if (!p) return false;
    return host === p || host.endsWith(`.${p}`);
  });
}

export type PolicyDecision =
  | { verdict: 'allow' }
  | { verdict: 'deny'; reason: string }
  | { verdict: 'approve'; reason: string };

export function evaluatePolicy(
  policy: Policy,
  risk: RiskClass,
  url: string,
  action: string,
): PolicyDecision {
  const host = hostOf(url);

  if (host && policy.denylist.length && matchesDomain(host, policy.denylist)) {
    return { verdict: 'deny', reason: `${host} is on the blocked list for this browser.` };
  }

  if (host && policy.allowlist.length && !matchesDomain(host, policy.allowlist)) {
    return {
      verdict: 'deny',
      reason: `${host} is not on the allowed list. The user restricted this agent to: ${policy.allowlist.join(', ')}.`,
    };
  }

  if (policy.requireApproval.includes(risk)) {
    return {
      verdict: 'approve',
      reason:
        risk === 'destructive'
          ? `"${action}" looks like it commits a real-world action`
          : `"${action}" can read credentials or run arbitrary code`,
    };
  }

  return { verdict: 'allow' };
}
