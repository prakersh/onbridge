/**
 * Failures onbridge composes itself that have to be recognised across a message boundary.
 *
 * The content script and the background are separate bundles, so an error thrown in one arrives in the other as text. Recognising it by its wording would be laundering: a page can throw from a getter during a DOM walk and choose the words. These classes are the alternative. A throw site uses the class; the content script reports the class as a code on its response, which nothing a page does can set; the background turns the code back into the class. Only the class, never the text, decides how the failure is reported.
 */

/** The ref names nothing on the page any more: the element was replaced or removed, or the ref was never issued. Carried to the agent as `ref-not-found`. */
export class RefNotFoundError extends Error {
  readonly code = 'ref-not-found' as const;
}

/** A `wait` ran out of time with its condition unmet. Carried as `wait-timeout`, so the agent can tell it from a page failure without reading the words. */
export class WaitTimeoutError extends Error {
  readonly code = 'wait-timeout' as const;
}

/** The code a content-script response carries for one of the classes above, or nothing. */
export function errorCodeOf(err: unknown): 'ref-not-found' | 'wait-timeout' | undefined {
  if (err instanceof RefNotFoundError) return err.code;
  if (err instanceof WaitTimeoutError) return err.code;
  return undefined;
}

/** The class behind a code the content script reported. Anything else stays a plain, page-derived error. */
export function errorFromCode(code: unknown, message: string): Error {
  if (code === 'ref-not-found') return new RefNotFoundError(message);
  if (code === 'wait-timeout') return new WaitTimeoutError(message);
  return new Error(message);
}
