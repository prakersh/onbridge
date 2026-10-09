/**
 * The opt-in blanking of personal data from page text.
 *
 * Every pattern here has honest false positives, so the point of these tests is as much what is left alone (prices, order numbers that do not look like phones, product ids) as what is hidden.
 */

import { describe, it, expect } from 'vitest';
import { redact } from '../src/tools/redact.js';

const ALL = ['phone', 'email', 'card'] as const;

describe('redact', () => {
  it('does nothing when nothing is asked for', () => {
    const t = 'Call +91 98765 43210 or write to a.b@example.com';
    expect(redact(t, [])).toBe(t);
  });

  it('hides email addresses', () => {
    expect(redact('Contact: ravi.kumar+shop@example.co.in today', ['email'])).toBe('Contact: [email redacted] today');
  });

  it('hides phone numbers in the usual Indian and international shapes', () => {
    expect(redact('Call 98765 43210', ['phone'])).toBe('Call [phone number redacted]');
    expect(redact('Call +91-98765-43210 now', ['phone'])).toBe('Call [phone number redacted] now');
    expect(redact('Tel (020) 1234 5678.', ['phone'])).toBe('Tel [phone number redacted].');
    expect(redact('+1 415 555 2671', ['phone'])).toBe('[phone number redacted]');
  });

  it('leaves prices, short numbers and ids alone', () => {
    const t = 'Price ₹1,23,456 · 2 in stock · PIN 400001 · ASIN B0CX1Y2Z3 · model 5G-128';
    expect(redact(t, ALL)).toBe(t);
  });

  it('hides card numbers that pass the Luhn check and leaves ones that do not', () => {
    expect(redact('Card 4111 1111 1111 1111 on file', ['card'])).toBe('Card [card number redacted] on file');
    expect(redact('Ref 4111 1111 1111 1112', ['card'])).toBe('Ref 4111 1111 1111 1112');
  });

  it('does not treat a card number as a phone number first', () => {
    expect(redact('4111111111111111', ALL)).toBe('[card number redacted]');
  });

  it('only knows the kinds it was given', () => {
    const t = 'Call 98765 43210 or write to a@b.io';
    expect(redact(t, ['email'])).toBe('Call 98765 43210 or write to [email redacted]');
  });
});
