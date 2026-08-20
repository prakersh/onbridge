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
  // Read-only, and previously in no set at all — so they fell through to the
  // `write` default and asked for approval in strict mode. Prompting for a
  // highlight is exactly the noise that teaches people to click Allow without
  // reading, which costs more than it buys. `scope.test.ts` now checks that
  // every action in ALL_COMMAND_ACTIONS lands in a set deliberately.
  'extract_text', 'list_actions', 'highlight',
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

/**
 * How much the user wants to be asked.
 *
 * Set from the side panel only — deliberately not reachable from any MCP tool.
 * An agent that can widen its own permissions makes the whole layer theatre.
 */
export type ApprovalMode =
  /** Nothing is asked. For unattended runs on sites you do not mind breaking. */
  | 'yolo'
  /** Risk-based: credential access and real-world consequences are asked. */
  | 'auto'
  /** Everything that changes state is asked, one action at a time. */
  | 'strict';

/**
 * Reads stay exempt even in strict mode. Approving every snapshot would make the
 * browser unusable and train the user to click Allow without reading it, which
 * is worse than not asking — the prompts that matter stop being noticed.
 */
export const MODE_APPROVALS: Record<ApprovalMode, RiskClass[]> = {
  yolo: [],
  auto: ['sensitive', 'destructive'],
  strict: ['navigate', 'write', 'sensitive', 'destructive'],
};

export interface Policy {
  mode: ApprovalMode;
  /** Empty means "any domain". Entries are hostname suffixes. */
  allowlist: string[];
  denylist: string[];
  /** Minutes of inactivity after which control mode revokes itself. 0 = never. */
  idleRevokeMinutes: number;
}

export const DEFAULT_POLICY: Policy = {
  mode: 'auto',
  allowlist: [],
  denylist: [],
  idleRevokeMinutes: 30,
};

/** Minutes before yolo drops back to auto on its own. */
export const YOLO_TIMEOUT_MINUTES = 60;

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

  // Domain lists are explicit user configuration, not a risk heuristic, so they
  // are enforced in every mode — including yolo. Turning off the prompts means
  // "stop asking me", not "ignore the boundaries I set".
  if (host && policy.denylist.length && matchesDomain(host, policy.denylist)) {
    return { verdict: 'deny', reason: `${host} is on the blocked list for this browser.` };
  }

  if (host && policy.allowlist.length && !matchesDomain(host, policy.allowlist)) {
    return {
      verdict: 'deny',
      reason: `${host} is not on the allowed list. The user restricted this agent to: ${policy.allowlist.join(', ')}.`,
    };
  }

  if (MODE_APPROVALS[policy.mode]?.includes(risk)) {
    return {
      verdict: 'approve',
      reason:
        risk === 'destructive'
          ? `"${action}" looks like it commits a real-world action`
          : risk === 'sensitive'
            ? `"${action}" can read credentials or run arbitrary code`
            : `you asked to approve every step`,
    };
  }

  return { verdict: 'allow' };
}

/**
 * URLs a command names as a destination, drawn from its own parameters.
 *
 * Kept separate from "where the browser currently is", because the two answer
 * different questions and only one of them used to be asked. A `navigate` whose
 * destination is never checked means a denylist cannot stop the agent reaching a
 * site — only stop it acting once the page has already loaded and run.
 */
export function destinationUrls(action: string, params: Record<string, unknown>): string[] {
  const out: string[] = [];
  // `navigate`, `new_tab` and `download_file` all carry their target here.
  if (typeof params.url === 'string' && params.url) out.push(params.url);
  return out;
}

/**
 * First domain-list refusal across every URL in play, or null if all are fine.
 *
 * Domain lists are user configuration rather than a risk heuristic, so a single
 * denied URL anywhere in the command's reach is enough to refuse it.
 */
export function firstDomainDenial(
  policy: Policy,
  urls: string[],
  risk: RiskClass,
  action: string,
): string | null {
  for (const url of urls) {
    const d = evaluatePolicy(policy, risk, url, action);
    if (d.verdict === 'deny') return d.reason;
  }
  return null;
}

/** Origin of a URL, or '' when it has none. Used to spot mid-approval drift. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
