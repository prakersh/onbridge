import type { AgentIdentity } from './handshake.js';

/**
 * Every action the bridge can carry, as a runtime list.
 *
 * A value, not just a type: `policy.ts` has to classify all of these, and a
 * union alone gives a test no way to check that it did. Three read-only tools
 * were silently falling through to the write default because nothing could
 * enumerate them.
 */
export const ALL_COMMAND_ACTIONS = [
  'navigate',
  'back',
  'forward',
  'reload',
  'snapshot',
  'find',
  'screenshot',
  'get_text',
  'get_url',
  'click',
  'click_by_text',
  'type',
  'fill_form',
  'select',
  'hover',
  'scroll',
  'press_key',
  'drag',
  'upload',
  'dismiss_modal',
  'dom_query',
  'list_tabs',
  'switch_tab',
  'new_tab',
  'close_tab',
  'evaluate',
  'wait',
  'get_cookies',
  'set_cookie',
  'console_logs',
  /** Recent network activity for the tab. Header values arrive redacted. */
  'network_requests',
  /**
   * One response body, fetched on demand. Deliberately separate from
   * `network_requests`: a body can carry credentials and personal data, so it
   * is classified higher and asked for explicitly rather than riding along with
   * every listing.
   */
  'network_request_body',
  'download_file',
  'list_downloads',
  'activity_log',
  /** Poses a question in the side panel and blocks until the user answers. */
  'ask_user',
  'bridge_status',
  'extract_text',
  'list_actions',
  'highlight',
] as const;

export type CommandAction = (typeof ALL_COMMAND_ACTIONS)[number];

// MCP Server → Extension
export type ServerMessage =
  | { type: 'command'; id: string; action: CommandAction; params: Record<string, unknown>; tabId?: number }
  /**
   * A late identity refinement. The bridge starts listening before the agent
   * client sends MCP `initialize`, so the extension can already be connected by
   * the time we learn the real client name. Rather than delay the handshake on
   * something that may never arrive, we hand over our best guess up front and
   * correct it here.
   */
  | { type: 'agent_identity'; agent: AgentIdentity }
  | { type: 'ping' };

// Extension → MCP Server
/** One console line, as it crosses the wire. */
export interface ConsoleDeltaEntry {
  level: string;
  text: string;
  timestamp: number;
}

export type ExtensionMessage =
  | { type: 'ready'; version: string; controlMode: boolean }
  | {
      type: 'result';
      id: string;
      success: boolean;
      data: unknown;
      error?: string;
      /**
       * Marks an error onbridge composed itself — a policy refusal, a scope
       * denial — as opposed to one carrying text from the page.
       *
       * Provenance has to travel with the message. Inferring it from the wording
       * lets a page throw `new Error("Blocked by user policy: ...")` and have its
       * text presented to the agent as an authoritative refusal. Absent means
       * "assume the page had a hand in it", which is the safe default and what an
       * older extension that does not send it will produce.
       */
      errorKind?: 'trusted';
      /**
       * A machine-readable name for the failure, so the agent can act on the
       * *kind* of error rather than pattern-matching English.
       *
       * `navigating` is the one that matters: a content script is torn down and
       * re-injected on every page load, and a command that lands in that window
       * used to surface Chrome's raw "Could not establish connection. Receiving
       * end does not exist." — indistinguishable, to an agent, from the page
       * genuinely not having the element. It is a retry, not a failure.
       *
       * Only ever set alongside `errorKind: 'trusted'`: a code is a claim about
       * provenance, and a page-derived error must not be able to present itself
       * as a well-known onbridge condition.
       */
      errorCode?: 'navigating' | 'no-content-script' | 'ref-not-found';
      /** How long to wait before retrying, for a retryable `errorCode`. */
      retryAfterMs?: number;
      /**
       * Console output the page produced *while this command ran*.
       *
       * Carried on the result rather than fetched separately so a failure is
       * legible at the moment it happens: a form submit that threw used to
       * return a bare "Typed successfully" and the explanation sat in the
       * console until the agent thought to go looking for it. Page-controlled,
       * so it is fenced like any other page text.
       */
      consoleDelta?: ConsoleDeltaEntry[];
      timing: number;
    }
  | {
      type: 'event';
      event:
        | 'navigation'
        | 'tab_changed'
        | 'dialog'
        | 'control_mode_changed'
        /**
         * An unsolicited note the user typed in the side panel. The server queues
         * it and attaches it to the next tool result — MCP is agent-initiated, so
         * there is no way to interrupt a turn that is already running.
         */
        | 'user_message';
      data: unknown;
    }
  | { type: 'pong' };

export const WS_PORT = 9876;
/** Scanned in order so several agents can run concurrently, each on its own port. */
export const WS_PORT_RANGE = [9876, 9877, 9878, 9879, 9880, 9881, 9882, 9883, 9884, 9885];
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const COMMAND_TIMEOUT_MS = 30_000;
/**
 * `ask_user` blocks on a human, so it cannot share the normal command timeout.
 * Kept below the two-minute mark that agent clients commonly enforce on a single
 * tool call — on expiry the tool returns "no answer yet" for the agent to retry,
 * rather than failing the turn.
 */
export const ASK_USER_TIMEOUT_MS = 110_000;
