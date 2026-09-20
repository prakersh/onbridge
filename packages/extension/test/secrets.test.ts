/**
 * Sensitive-data placeholders.
 *
 * The property under test is the same one the pairing secret already enjoys:
 * the value never travels to the agent. Everything here checks the two doors —
 * substitution only on an exact origin match, and masking on the way back out.
 * A miss on either side is a credential handed to whoever authored the page or
 * whoever holds the bridge socket.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// The module reads chrome.storage.local, which does not exist under vitest.
// A minimal in-memory stand-in is enough: get/set by key, plus the onChanged
// hook the module uses to keep its cache honest across contexts.
let store: Record<string, unknown> = {};
const changeListeners: Array<(changes: object, area: string) => void> = [];

(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: store[key] }),
      set: async (items: Record<string, unknown>) => {
        Object.assign(store, items);
        for (const fn of changeListeners) fn({}, 'local');
      },
    },
    onChanged: {
      addListener: (fn: (changes: object, area: string) => void) => {
        changeListeners.push(fn);
      },
    },
  },
};

const { listSecrets, saveSecret, deleteSecret, hasPlaceholder, resolvePlaceholders, maskSecrets } =
  await import('../src/core/secrets.js');

beforeEach(async () => {
  store = {};
  // The module caches; a set through the real API fires onChanged and clears it.
  await chrome.storage.local.set({});
});

describe('saveSecret / listSecrets', () => {
  it('lists name, origin and age — and never the value', async () => {
    await saveSecret('github_password', 'hunter2', 'https://github.com');
    const list = await listSecrets();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('github_password');
    expect(list[0].origin).toBe('https://github.com');
    expect(list[0].createdAt).toBeGreaterThan(0);
    // The record type has no value field, but the runtime object must not
    // smuggle one either — this is what the panel renders.
    expect(Object.values(list[0] as unknown as Record<string, unknown>)).not.toContain('hunter2');
  });

  it('normalises a bare hostname to an https origin', async () => {
    await saveSecret('pw', 'v', 'GitHub.com');
    const [rec] = await listSecrets();
    expect(rec.origin).toBe('https://github.com');
  });

  it('strips path, default port and case from the origin', async () => {
    await saveSecret('pw', 'v', 'HTTPS://GitHub.com:443/login?next=/');
    const [rec] = await listSecrets();
    expect(rec.origin).toBe('https://github.com');
  });

  it('overwrites an existing secret of the same name', async () => {
    await saveSecret('pw', 'old', 'https://a.test');
    await saveSecret('pw', 'new', 'https://b.test');
    const list = await listSecrets();
    expect(list).toHaveLength(1);
    expect(list[0].origin).toBe('https://b.test');
    const r = await resolvePlaceholders('{{secret:pw}}', 'https://b.test');
    expect(r.text).toBe('new');
  });

  it('rejects names outside the safe charset', async () => {
    await expect(saveSecret('bad name', 'v', 'https://a.test')).rejects.toThrow();
    await expect(saveSecret('a}}b', 'v', 'https://a.test')).rejects.toThrow();
    await expect(saveSecret('', 'v', 'https://a.test')).rejects.toThrow();
  });

  it('rejects an empty value and an unparseable origin', async () => {
    await expect(saveSecret('ok', '', 'https://a.test')).rejects.toThrow();
    await expect(saveSecret('ok', 'v', 'not a url at all')).rejects.toThrow();
  });
});

describe('deleteSecret', () => {
  it('removes the secret and is idempotent', async () => {
    await saveSecret('pw', 'v', 'https://a.test');
    await deleteSecret('pw');
    expect(await listSecrets()).toHaveLength(0);
    await deleteSecret('pw');
    expect(await listSecrets()).toHaveLength(0);
  });
});

describe('hasPlaceholder', () => {
  it('spots a placeholder anywhere in the text', () => {
    expect(hasPlaceholder('user@{{secret:pw}}!')).toBe(true);
    expect(hasPlaceholder('{{secret:a-b_c9}}')).toBe(true);
  });

  it('spots even a malformed placeholder, so the caller can fail closed', () => {
    // "bad name" can never resolve — but if this returned false, background
    // would skip resolution and type the literal text with no refusal recorded.
    expect(hasPlaceholder('{{secret:bad name}}')).toBe(true);
  });

  it('ignores plain text and other template syntax', () => {
    expect(hasPlaceholder('no secrets here')).toBe(false);
    expect(hasPlaceholder('{{other:thing}}')).toBe(false);
    expect(hasPlaceholder('{secret:pw}')).toBe(false);
  });
});

describe('resolvePlaceholders', () => {
  beforeEach(async () => {
    await saveSecret('gh', 'gh-value', 'https://github.com');
    await saveSecret('other', 'other-value', 'https://other.test');
  });

  it('substitutes when the page origin matches the binding exactly', async () => {
    const r = await resolvePlaceholders('pw: {{secret:gh}}', 'https://github.com');
    expect(r.text).toBe('pw: gh-value');
    expect(r.used).toEqual(['gh']);
    expect(r.refused).toEqual([]);
  });

  it('substitutes every occurrence, and counts the secret once', async () => {
    const r = await resolvePlaceholders('{{secret:gh}} {{secret:gh}}', 'https://github.com');
    expect(r.text).toBe('gh-value gh-value');
    expect(r.used).toEqual(['gh']);
  });

  it('refuses on a different origin and leaves the placeholder untouched', async () => {
    const r = await resolvePlaceholders('{{secret:gh}}', 'https://evil.test');
    expect(r.text).toBe('{{secret:gh}}');
    expect(r.used).toEqual([]);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0].name).toBe('gh');
    expect(r.refused[0].reason).toMatch(/origin/i);
    // The refusal must not disclose where the secret is actually bound — that
    // tells the agent (and via it, a hostile page) where the user has accounts.
    expect(r.refused[0].reason).not.toContain('github.com');
  });

  it('treats scheme and port as part of the origin', async () => {
    const http = await resolvePlaceholders('{{secret:gh}}', 'http://github.com');
    expect(http.refused).toHaveLength(1);
    const port = await resolvePlaceholders('{{secret:gh}}', 'https://github.com:8443');
    expect(port.refused).toHaveLength(1);
  });

  it('refuses a subdomain — the binding is an origin, not a suffix', async () => {
    const r = await resolvePlaceholders('{{secret:gh}}', 'https://gist.github.com');
    expect(r.refused).toHaveLength(1);
  });

  it('refuses an unknown name', async () => {
    const r = await resolvePlaceholders('{{secret:nope}}', 'https://github.com');
    expect(r.text).toBe('{{secret:nope}}');
    expect(r.refused[0]).toMatchObject({ name: 'nope' });
  });

  it('refuses a malformed name instead of typing it into the page', async () => {
    const r = await resolvePlaceholders('{{secret:bad name}}', 'https://github.com');
    expect(r.text).toBe('{{secret:bad name}}');
    expect(r.refused).toHaveLength(1);
  });

  it('refuses everything when the page origin is empty or opaque', async () => {
    for (const origin of ['', 'null', 'about:blank']) {
      const r = await resolvePlaceholders('{{secret:gh}}', origin);
      expect(r.used).toEqual([]);
      expect(r.refused).toHaveLength(1);
    }
  });

  it('resolves each placeholder against its own binding', async () => {
    const r = await resolvePlaceholders('{{secret:gh}}+{{secret:other}}', 'https://github.com');
    expect(r.text).toBe('gh-value+{{secret:other}}');
    expect(r.used).toEqual(['gh']);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0].name).toBe('other');
  });

  it('passes through text with no placeholders', async () => {
    const r = await resolvePlaceholders('just text', 'https://github.com');
    expect(r).toEqual({ text: 'just text', used: [], refused: [] });
  });
});

describe('maskSecrets', () => {
  it('returns the input unchanged when nothing is stored', async () => {
    const text = 'nothing to hide';
    expect(await maskSecrets(text)).toBe(text);
  });

  it('masks every occurrence of a stored value', async () => {
    await saveSecret('gh', 'hunter2', 'https://github.com');
    expect(await maskSecrets('pw=hunter2 again hunter2')).toBe(
      'pw=[secret:gh] again [secret:gh]',
    );
  });

  it('masks regardless of which origin the text came from', async () => {
    // A phishing page that captured the value must not be able to echo it back
    // into the agent's context just because it is not the binding origin.
    await saveSecret('gh', 'hunter2', 'https://github.com');
    expect(await maskSecrets('leaked: hunter2')).toBe('leaked: [secret:gh]');
  });

  it('masks longer values first so a substring secret cannot split another', async () => {
    await saveSecret('short', 'abc', 'https://a.test');
    await saveSecret('long', 'abcdef', 'https://a.test');
    expect(await maskSecrets('x abcdef y abc z')).toBe('x [secret:long] y [secret:short] z');
  });

  it('treats the value as a literal string, not a pattern', async () => {
    await saveSecret('rx', 'a.c$[', 'https://a.test');
    expect(await maskSecrets('v=a.c$[;')).toBe('v=[secret:rx];');
    expect(await maskSecrets('v=abc;')).toBe('v=abc;');
  });
});
