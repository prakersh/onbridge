export interface DomNode {
  role: string;
  name?: string;
  ref?: number;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  placeholder?: string;
  href?: string;
  type?: string;
  expanded?: boolean;
  selected?: boolean;
  level?: number;
  children?: DomNode[];
}

export interface ScrollState {
  percent: number;
  pagesAbove: number;
  pagesBelow: number;
}

export interface PageSnapshot {
  url: string;
  title: string;
  tree: DomNode[];
  scroll: ScrollState;
  refCount: number;
}

export interface FindResult {
  ref: number;
  role: string;
  name: string;
  context: string;
  /**
   * Absolute destination, for links.
   *
   * Without it the only way to follow a result was to click it, and a
   * navigating click is the most failure-prone thing the bridge does. Being
   * able to read the href and `navigate` to it directly removes a whole class
   * of clicking — an agent picking a search result no longer has to guess.
   */
  href?: string;
}

/**
 * The result of an action that may move the page: `click`, `click_by_text`,
 * `scroll`, `dismiss_modal`, `navigate`.
 *
 * Shaped this way because the old contract — "return a PageSnapshot" — made a
 * *successful* action indistinguishable from a failed one. A click that
 * navigated tore down the content script, the post-click snapshot could not be
 * built, and the whole call was reported as an error (`snapshot.tree is not
 * iterable`) even though the click had already happened. An agent that sees an
 * error retries, and retrying a click that already went through is how an order
 * gets placed twice.
 *
 * So the action's outcome and the page's new state are separate facts.
 * `ok: true` means the action executed. `snapshot` is best-effort: its absence
 * is reported in `snapshotError` and never turns the call into a failure.
 */
export interface ActionResult {
  /** The action executed. False never appears — a refusal throws instead. */
  ok: true;
  action: string;
  /** Whether the tab moved to a different document because of this action. */
  navigated: boolean;
  /** Where the tab is now. Always present, even when no snapshot could be built. */
  url: string;
  title: string;
  /** Where the tab was before. Present when `navigated`. */
  from?: string;
  /**
   * For same-page actions: whether anything in the DOM changed at all. Absent
   * when it could not be determined.
   */
  domChanged?: boolean;
  snapshot?: PageSnapshot;
  /**
   * Why there is no snapshot. onbridge-composed text, never page-derived.
   */
  snapshotError?: string;
  /** The action was dispatched as real CDP input rather than synthetic events. */
  trusted?: boolean;
  /**
   * Set by `navigate` when the page that loaded is not on the origin that was
   * asked for — a redirect, an interstitial, or a human typing in the omnibox
   * mid-command. Silently returning the wrong page is the failure this prevents.
   */
  redirectedFrom?: string;
}

/** What `extract_text` returns. Never a bare string — see `empty`. */
export interface ExtractTextResult {
  text: string;
  truncated: boolean;
  chars: number;
  /**
   * The ref resolved to a real element that genuinely has no readable text.
   * Distinguishes that from "the walker missed it", which used to look
   * identical: both came back as `""` and the agent believed the page was empty.
   */
  empty?: boolean;
  /** The ref named no element on the page. */
  error?: 'ref-not-found';
}
