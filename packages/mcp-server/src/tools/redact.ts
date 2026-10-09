/**
 * Blanks personal data out of page text before it reaches the agent.
 *
 * Opt-in (`ONBRIDGE_REDACT`, or the panel's preference), because every pattern here has honest false positives: an order number can look like a phone number. The user who turns it on is choosing to lose those over having a stranger's phone number from a site's address book land in a transcript. Applied at the untrusted fence, so it covers every tool that returns page text, and never to text the server composed.
 *
 * Addresses are deliberately not attempted. There is no pattern that finds "12 Baker Street" without also finding half of every product listing, and a redaction that only sometimes works is worse than one that is known not to exist.
 */
import type { RedactionKind } from '@onbridge/shared';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;

/** 13 to 19 digits, optionally grouped by spaces or hyphens, that pass the Luhn check. Run before phones: a 13-digit card is a 13-digit run either way. */
const CARD = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;

/**
 * 10 to 13 digits in all, with an optional country code and area code, grouped by spaces, dots, hyphens or nothing. The pattern only finds the shape; the digit count is checked on the match, so a six-digit PIN code or an eight-digit order number is left alone. Commas are not separators, so an Indian price such as 1,23,456 is left alone too; a 13-digit run that passed the card check above is already gone.
 */
const PHONE = /(?<![\w@.\-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d(?:[\s.-]?\d){6,12}(?![\w@])/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function digitsOf(s: string): string {
  return s.replace(/\D/g, '');
}

export function redact(text: string, kinds: readonly RedactionKind[]): string {
  if (!text || kinds.length === 0) return text;
  let out = text;
  if (kinds.includes('email')) out = out.replace(EMAIL, '[email redacted]');
  if (kinds.includes('card')) {
    out = out.replace(CARD, (m) => {
      const d = digitsOf(m);
      return d.length >= 13 && d.length <= 19 && luhn(d) ? '[card number redacted]' : m;
    });
  }
  if (kinds.includes('phone')) {
    out = out.replace(PHONE, (m) => {
      const n = digitsOf(m).length;
      return n >= 10 && n <= 13 ? '[phone number redacted]' : m;
    });
  }
  return out;
}
