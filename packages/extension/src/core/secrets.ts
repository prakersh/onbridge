/**
 * Sensitive-data placeholders.
 *
 * The pairing secret set the precedent: derived, never transmitted, never in a
 * tool result. This module extends that to user credentials. The agent writes
 * `{{secret:name}}` into a `type` or `fill_form` value; the real value is
 * substituted here, inside the extension, and only when the page's origin is
 * the one the user bound the secret to. Nothing in this file may return a
 * value to a caller except `resolvePlaceholders` (into the keystroke path) and
 * `maskSecrets` (which only ever removes values from text).
 *
 * Values live in chrome.storage.local, which no web page can reach — it is
 * scoped to the extension id and only extension pages and the worker can read
 * it. That is the same store the policy already trusts.
 */

/** What the panel and the agent may see: never the value. */
export interface SecretRecord {
  name: string;
  origin: string;
  createdAt: number;
}

interface StoredSecret extends SecretRecord {
  value: string;
}

const STORAGE_KEY = 'secrets_v1';

/**
 * The charset is the security perimeter for names: they travel inside
 * placeholder syntax, appear in refusal messages the agent reads, and become
 * `[secret:name]` masks. Letters, digits, underscore and hyphen cannot close a
 * `}}`, fake other template syntax, or smuggle markup into the panel.
 */
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Two shapes on purpose. The strict one is what actually substitutes. The
 * loose one exists for `hasPlaceholder` and refusal reporting: a malformed
 * name can never resolve, but if it were invisible here, background would
 * treat the text as plain and type the literal placeholder into the page with
 * no refusal recorded anywhere.
 */
const PLACEHOLDER_RE = /\{\{secret:([^}]*)\}\}/g;

/**
 * One storage read per call is cheap but not free on the paths that run per
 * keystroke batch, so the parsed store is cached. Panel and worker are
 * separate JS contexts with separate caches; `onChanged` fires in both, which
 * is what keeps a write made in one honest in the other.
 */
let cache: StoredSecret[] | null = null;

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener(() => {
    cache = null;
  });
}

async function loadStore(): Promise<StoredSecret[]> {
  if (cache) return cache;
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const raw = result[STORAGE_KEY];
  cache = Array.isArray(raw) ? (raw as StoredSecret[]) : [];
  return cache;
}

async function writeStore(secrets: StoredSecret[]): Promise<void> {
  cache = secrets;
  await chrome.storage.local.set({ [STORAGE_KEY]: secrets });
}

/**
 * Origins compare as scheme + host + port because that is the boundary the
 * browser itself enforces: http://github.com is a different principal from
 * https://github.com (anyone on the network can be the former), and a
 * subdomain or odd port is a different principal again. Matching on anything
 * looser — hostname, suffix — would hand the secret to a principal the user
 * never named. `URL.origin` does the canonicalising (case, default ports,
 * paths); a bare hostname is read as https, never http.
 */
function normalizeOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const origin = new URL(withScheme).origin;
    // Opaque origins ("null") come from sandboxed frames and data: URLs — no
    // principal to bind to, so no match is possible.
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

export async function listSecrets(): Promise<SecretRecord[]> {
  const secrets = await loadStore();
  // Rebuilt field by field rather than spread-minus-value: a future field on
  // StoredSecret must opt in to being shown, not opt out of being leaked.
  return secrets.map(({ name, origin, createdAt }) => ({ name, origin, createdAt }));
}

export async function saveSecret(name: string, value: string, origin: string): Promise<void> {
  if (!NAME_RE.test(name)) {
    throw new Error('Secret names may only contain letters, digits, underscore and hyphen.');
  }
  if (!value) {
    throw new Error('Secret value must not be empty.');
  }
  const normalized = normalizeOrigin(origin);
  if (!normalized) {
    throw new Error('Origin must be a valid URL or hostname, e.g. https://github.com.');
  }
  const secrets = (await loadStore()).filter((s) => s.name !== name);
  secrets.push({ name, value, origin: normalized, createdAt: Date.now() });
  await writeStore(secrets);
}

export async function deleteSecret(name: string): Promise<void> {
  const secrets = await loadStore();
  const remaining = secrets.filter((s) => s.name !== name);
  if (remaining.length !== secrets.length) await writeStore(remaining);
}

/** True if the text contains at least one {{secret:...}} placeholder. */
export function hasPlaceholder(text: string): boolean {
  PLACEHOLDER_RE.lastIndex = 0;
  return PLACEHOLDER_RE.test(text);
}

/**
 * Substitutes placeholders for the page's real origin.
 *
 * Fails closed on every branch: an unknown name, a malformed name, a binding
 * to any other origin, or a page whose origin cannot be established all land
 * in `refused` and the placeholder stays as literal text. The caller is
 * expected to refuse the whole command when `refused` is non-empty rather
 * than type a half-resolved string — that decision deliberately lives with
 * the dispatcher, which knows what the command was.
 *
 * Refusal reasons name the placeholder, never the bound origin: telling the
 * agent where a secret *would* work is a map of where the user has accounts.
 */
export async function resolvePlaceholders(
  text: string,
  pageOrigin: string,
): Promise<{ text: string; used: string[]; refused: Array<{ name: string; reason: string }> }> {
  const used = new Set<string>();
  const refusedByName = new Map<string, string>();

  if (!hasPlaceholder(text)) return { text, used: [], refused: [] };

  const secrets = await loadStore();
  const normalizedPage = normalizeOrigin(pageOrigin);

  const resolved = text.replace(PLACEHOLDER_RE, (whole, name: string) => {
    if (!NAME_RE.test(name)) {
      refusedByName.set(name, 'not a valid secret name');
      return whole;
    }
    const record = secrets.find((s) => s.name === name);
    if (!record) {
      refusedByName.set(name, 'no secret with this name is stored');
      return whole;
    }
    if (!normalizedPage) {
      refusedByName.set(name, 'the page has no origin to check the binding against');
      return whole;
    }
    if (record.origin !== normalizedPage) {
      refusedByName.set(name, `this secret is not bound to the page's origin (${normalizedPage})`);
      return whole;
    }
    used.add(name);
    return record.value;
  });

  return {
    text: resolved,
    used: [...used],
    refused: [...refusedByName].map(([name, reason]) => ({ name, reason })),
  };
}

/**
 * Replaces any occurrence of a stored secret value with a mask.
 *
 * The return door of the fence: a page that received a secret (legitimately
 * or by phishing the substitution's origin — it cannot, but a past leak or a
 * reused password can put the value in reach) may reflect it into the DOM, a
 * title, or an error message, all of which flow back towards the agent. This
 * runs on those paths, so origin does not matter here — a value is masked
 * wherever it appears.
 */
export async function maskSecrets(text: string): Promise<string> {
  const secrets = await loadStore();
  if (secrets.length === 0 || !text) return text;
  // Longest value first, so a secret that is a substring of another cannot
  // break the longer one into maskable-looking fragments.
  const byLength = [...secrets].sort((a, b) => b.value.length - a.value.length);
  let out = text;
  for (const { name, value } of byLength) {
    if (value && out.includes(value)) out = out.split(value).join(`[secret:${name}]`);
  }
  return out;
}
