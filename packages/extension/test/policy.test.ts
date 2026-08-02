import { describe, it, expect } from 'vitest';
import {
  classify,
  evaluatePolicy,
  DEFAULT_POLICY,
  DESTRUCTIVE_TEXT,
  type Policy,
} from '../src/core/policy.js';

describe('risk classification', () => {
  it('treats observation as read', () => {
    for (const a of ['snapshot', 'find', 'get_text', 'get_url', 'screenshot']) {
      expect(classify(a), a).toBe('read');
    }
  });

  it('treats credential and code-execution primitives as sensitive', () => {
    // These are what a prompt-injected agent reaches for.
    for (const a of ['get_cookies', 'set_cookie', 'evaluate', 'upload', 'download_file']) {
      expect(classify(a), a).toBe('sensitive');
    }
  });

  it('treats ordinary interaction as write', () => {
    expect(classify('click', 'Read more')).toBe('write');
    expect(classify('type', 'Search')).toBe('write');
  });

  it('escalates a click to destructive based on its label', () => {
    expect(classify('click', 'Place order · $249')).toBe('destructive');
    expect(classify('click', 'Delete account')).toBe('destructive');
    expect(classify('click', 'Confirm payment')).toBe('destructive');
    expect(classify('click', 'Send message')).toBe('destructive');
    expect(classify('click', 'Transfer funds')).toBe('destructive');
  });

  it('does not escalate innocuous labels that merely contain similar words', () => {
    expect(classify('click', 'Buyers guide')).toBe('write');
    expect(classify('click', 'Undelete history')).toBe('write');
  });

  it('fails towards caution for unknown actions', () => {
    // A tool added later must not be silently permitted as a read.
    expect(classify('some_future_action')).toBe('write');
  });
});

describe('destructive text matcher', () => {
  it('matches on word boundaries, not substrings', () => {
    expect(DESTRUCTIVE_TEXT.test('Buy now')).toBe(true);
    expect(DESTRUCTIVE_TEXT.test('Rebuy')).toBe(false);
  });
});

describe('domain policy', () => {
  const withAllow = (allowlist: string[]): Policy => ({ ...DEFAULT_POLICY, allowlist });

  it('allows any domain when the allowlist is empty', () => {
    expect(evaluatePolicy(DEFAULT_POLICY, 'write', 'https://anything.com/x', 'click').verdict).toBe(
      'allow',
    );
  });

  it('denies a domain outside the allowlist', () => {
    const d = evaluatePolicy(withAllow(['github.com']), 'write', 'https://evil.com/x', 'click');
    expect(d.verdict).toBe('deny');
  });

  it('allows subdomains of an allowlisted domain', () => {
    const d = evaluatePolicy(withAllow(['example.com']), 'write', 'https://app.example.com/x', 'click');
    expect(d.verdict).toBe('allow');
  });

  it('does not let a lookalike domain pass as a suffix', () => {
    // "notexample.com" must not satisfy an "example.com" allowlist.
    const d = evaluatePolicy(withAllow(['example.com']), 'write', 'https://notexample.com/', 'click');
    expect(d.verdict).toBe('deny');
  });

  it('denylist wins over an otherwise permissive policy', () => {
    const p: Policy = { ...DEFAULT_POLICY, denylist: ['bank.com'] };
    expect(evaluatePolicy(p, 'read', 'https://bank.com/', 'snapshot').verdict).toBe('deny');
  });

  it('denylist is checked before the allowlist', () => {
    const p: Policy = { ...DEFAULT_POLICY, allowlist: ['bank.com'], denylist: ['bank.com'] };
    expect(evaluatePolicy(p, 'read', 'https://bank.com/', 'snapshot').verdict).toBe('deny');
  });
});

describe('approval requirements', () => {
  it('requires approval for sensitive and destructive by default', () => {
    expect(evaluatePolicy(DEFAULT_POLICY, 'sensitive', 'https://x.com/', 'get_cookies').verdict).toBe(
      'approve',
    );
    expect(evaluatePolicy(DEFAULT_POLICY, 'destructive', 'https://x.com/', 'click').verdict).toBe(
      'approve',
    );
  });

  it('lets reads, navigation and ordinary writes through', () => {
    for (const risk of ['read', 'navigate', 'write'] as const) {
      expect(evaluatePolicy(DEFAULT_POLICY, risk, 'https://x.com/', 'click').verdict, risk).toBe(
        'allow',
      );
    }
  });

  it('carries a reason the agent can act on', () => {
    const d = evaluatePolicy(DEFAULT_POLICY, 'destructive', 'https://x.com/', 'click');
    expect(d.verdict).toBe('approve');
    if (d.verdict === 'approve') expect(d.reason.length).toBeGreaterThan(10);
  });
});
