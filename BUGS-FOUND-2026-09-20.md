# onbridge — defects found in live use, 2026-09-20

Found while driving a real Chrome session (onbridge 0.3.1, macOS, extension built from
`packages/extension/.output/chrome-mv3`) for a research task across Amazon.in, Google,
DuckDuckGo and vendor sites.

Bug 1 is filed as https://github.com/prakersh/onbridge/issues/1; Bugs 2-6 and the feature
gaps as https://github.com/prakersh/onbridge/issues/2.

**All of these are fixed in v0.4.0.** A "Resolution" line follows each one. The attached
screen recording was reference material only and is not in the repository.

Commits: `74fb17b` (the bulk), `d48c842` (`fill_form` submits), `HEAD` (DOM-quiet settle,
href forms, tool-description steering).

---

## Bug 1 — Stale extension-side pairing secret is an unrecoverable dead end

**Status:** FIXED in v0.4.0 — filed as https://github.com/prakersh/onbridge/issues/1

Kept here so the set is complete. Summary: when the extension holds a secret that does not
match `peers.json` for its extension id, the handshake dead-ends at `invalid auth proof`
with no recovery path in the UI, `pairingWasReset` cannot be set on that branch, the
recovery guidance ("remove `~/.onbridge/peers.json`") is a trap if followed partially
because TOFU then refuses the very extension being fixed, and the panel asserts the record
"was replaced" as fact when the server holds the `peers.json` mtime that disproves it.

**Resolution** (`74fb17b`). Root cause was Bug 6 (below), plus a second identity race nobody had spotted:
`getServerId()` re-read `server-key.json` on every call, so two servers starting together each
generated an id and each overwrote the other's file — a process could announce id X in
`hello_ack` and then save the pairing record under the *other* process's id Y. It is now read
once per process and created under a lock.

The dead end itself is gone three ways. The extension no longer commits to a secret at
`hello_ack`, so a `challenge` that arrives where `pair_required` was implied is answered with
the stored secret rather than the wrong one (`HANDSHAKE_VERSION` 3). A `challenge` with no
stored secret sends `pair_reset` instead of failing. And the panel has **Forget this pairing
and pair again**, which clears exactly one `(extensionId, serverId)` record on the browser side
and re-runs the approval — the existing `clear_pairings` is now reachable too, behind a
confirmation.

The message no longer asserts a cause. `auth_fail` carries `PairingEvidence` — when the record
was made, when it was last used, when the peer file was last written, how many servers are
running — and the panel reports those and says which reading they support. The TOFU guidance
now says to delete the *whole* peer file and explains why removing one entry is worse.

Also fixed from "Spotted alongside": `ONBRIDGE_HOME` is resolved per call rather than captured
at import, which is how a fixture id reached a real peer store.

---

## Bug 2 — `click` and `click_by_text` throw `snapshot.tree is not iterable` on navigation

**Severity:** high — this is the single most disruptive defect found.

**What happens:** any click that causes a page navigation returns:

```
snapshot.tree is not iterable
```

The click itself often *succeeds*; only the post-click snapshot build fails. So the tool
reports failure while having performed the action. That is the worst possible shape for an
agent-facing API: it invites a retry of an action that already happened.

**Worse, it is not deterministic.** Observed both outcomes from the same call shape:

- Amazon search results, clicked a product title link (`ref` from a fresh snapshot) →
  error returned, **navigation happened** (`get_url` confirmed the product page).
- Amazon search results, clicked a different product title link → error returned,
  **navigation did not happen** (`get_url` still showed the search page).

An agent cannot tell these apart without an extra `get_url` after every click.

**Repro:**
1. `navigate` to `https://www.amazon.in/s?k=VoLTE+GSM+VoIP+gateway+SIP`
2. `snapshot` (or `find`) to get a ref for any product-title link
3. `click` that ref

Also reproduced via `click_by_text` with `role: link`, so it is not ref resolution.

**Suspected cause:** the post-action snapshot is captured after the content script has been
torn down by navigation, yielding a `snapshot` object whose `tree` is undefined; the
iteration then throws and masks the successful click.

**Suggested fix:** await navigation settle before snapshotting, and on snapshot failure
still return action success plus the new URL, e.g. `{ ok: true, navigated: true, url }`.
Never report a performed action as a failure.

**Resolution — FIXED in v0.4.0** (`74fb17b`). Diagnosis confirmed, and there was a second cause: the
extension slept a flat 300ms after a click and compared URLs, so a navigation that committed
at 400-600ms was recorded as "did not navigate" *and* then failed snapshotting a document
being torn down — which is the non-determinism reported here. `click`, `click_by_text`,
`scroll`, `dismiss_modal` and `navigate` now return `ActionResult`
(`{ ok, action, navigated, url, title, from?, domChanged?, snapshot?, snapshotError? }`).
Navigation is detected from recorded `webNavigation.onBeforeNavigate` intent rather than a
sleep, waited out to `complete`, and the snapshot is best effort: if it fails, the call still
succeeds and says why. `serializeSnapshot` also no longer throws on a treeless object, as a
last line of defence. Covered by `packages/mcp-server/test/action-results.test.ts`,
`packages/shared/test/serializer.test.ts`, and five checks in `scripts/verify-browser.mjs`.

A third contributing defect turned up while fixing this: `find`, `list_actions` and `dom_query`
returned the content script's *frame-local* refs while `snapshot` returned global ones, so a
ref from `find` was translated as though it were global and the command landed on a different
element — which also explains a click that "did nothing". Those results are globalised now.

---

## Bug 3 — Content script connection lost after a navigating click

**Severity:** medium. Likely the same root cause as Bug 2.

Immediately after a `click_by_text` that returned the Bug 2 error, the next `dom_query`
returned:

```
Could not establish connection. Receiving end does not exist.
```

A following `get_url` succeeded and showed the new page had in fact loaded, and a repeat
`dom_query` then worked. So the tool surface is briefly unusable during navigation with no
"page is navigating, retry" signal to distinguish it from a genuine failure.

**Suggested fix:** detect the disconnected content script and either wait for re-injection
or return a typed, retryable error rather than a raw Chrome messaging string.

**Resolution — FIXED in v0.4.0** (`74fb17b`). Both. `routeToContentScript` re-delivers across the
navigation window (up to three attempts, waiting for the tab to go quiet between them) and, if
it persists, throws a `RetryableError` carrying `errorCode: 'navigating'` and `retryAfterMs` on
the wire. The agent sees `[retryable: navigating] Nothing was changed by this call — making it
again is safe.` A code only ever rides on a trusted error, so a page cannot present itself as a
known onbridge condition.

---

## Bug 4 — `extract_text` with a `ref` silently returns empty

**Severity:** medium — silent wrong answer, no error.

On the Amazon search results page, `extract_text` scoped to a container ref returned an
empty string. The same call without `ref` returned the full page text correctly, including
all the content inside that container.

**Repro:**
1. `navigate` to an Amazon.in search results page
2. `snapshot` and take the ref of the results container (in this run, `152`)
3. `extract_text` with that `ref` → empty
4. `extract_text` with no `ref` → full text, containing that container's content

Empty is indistinguishable from "this element genuinely has no text", so an agent will draw
a wrong conclusion rather than retry. Returning an error when the ref resolves to nothing
readable would be safer than returning `""`.

**Resolution — FIXED in v0.4.0** (`74fb17b`). `extract_text` now returns three distinguishable answers:
`{ error: 'ref-not-found' }`, `{ text: '', empty: true }`, or the text. The tool renders each
as different prose, so a bare `""` can no longer reach the agent. The structured walk also
falls back to `innerText`/`textContent` when it produces nothing, so a container whose text
lives somewhere the walker does not look returns unformatted text rather than a confident
wrong answer. The likeliest trigger on that Amazon page — a ref from `find` being
mistranslated into a different element — is fixed separately under Bug 2. Covered by
`action-results.test.ts` and four browser checks including a shadow-DOM container.

---

## Bug 5 — `navigate` landed on a different page than requested (UNCONFIRMED)

**Severity:** unknown. Recorded because it is a correctness claim about the core tool.

A `navigate` to a `html.duckduckgo.com/html/?q=...` URL returned a snapshot of a **Google
search results page for the query "google"**, with a Chrome-omnibox-shaped URL
(`google.com/search?...&sourceid=chrome&source=chrome.ob`). The requested URL never loaded.
An immediate retry of a similar DuckDuckGo URL worked normally.

**Caveat:** the human may have been typing in the same window at that moment, which would
explain it entirely. Not reproduced. Needs a second sighting before it is worth acting on —
noted so that if anyone else sees it there is a prior report.

**Resolution — MADE VISIBLE in v0.4.0** (`74fb17b`). Not investigated further, as agreed. `navigate` now
compares the origin it landed on with the one that was asked for and sets `redirectedFrom` when
they differ; the reply tells the agent plainly that this is not the origin it requested. So a
hijacked or human-interrupted navigation shows up in the result instead of silently returning
the wrong page. If it recurs, that line will be in the transcript.

---

## Feature gaps noticed alongside (not bugs)

**No way to suppress the snapshot on `navigate`.** — *Resolved in v0.4.0: `navigate` takes
`snapshot: false`, `compact` and `depth`, and its description points at the cheap pattern.*
 Every `navigate` returns a full snapshot
with no opt-out. On heavy sites this is enormous — a single Amazon.in search results page
cost roughly 8,000 tokens of structure, almost all of it navigation chrome, filter lists and
footer links, when the goal was to read ten product titles and prices. `snapshot` already
takes `compact` and `depth`; `navigate` should accept the same, plus a way to skip the
snapshot entirely and follow up with `extract_text`. For an agent paying per token this is
the difference between a cheap tool and an expensive one.

**`dom_query` cannot return attributes, only text.** — *Resolved in v0.4.0: `dom_query` has an
`attr` action, `list` carries absolute hrefs for anchors, and `find` and `list_actions` report
hrefs too.*
 There is no way to read an `href`. That
is why a navigating `click` was needed at all — and Bug 2 made it unreliable. Being able to
read hrefs from a result list and then `navigate` to them directly would have side-stepped
the whole problem. An `attr` action, or including `href` on `list` matches for anchors,
would remove a class of clicking entirely.

**No panel control for clearing pairings.** `clear_pairings` exists in `background.ts` with
no UI reaching it. See Bug 1. — *Resolved in v0.4.0: a Pairings section in the panel forgets
one agent's pairing or, behind a confirmation, all of them.*

---

## Bug 6 — Every agent session is a separate pairing prompt, and concurrent servers clobber one another's secret

**Severity:** high. This is almost certainly the **root cause of Bug 1**, not a separate defect.

**Reported symptom (human):** repeated prompts that "another session is trying to connect",
frequently enough to read as noise rather than as a security signal.

### The mechanism, from the code

```
packages/shared/src/protocol.ts:135
  export const WS_PORT_RANGE = [9876, 9877, 9878, 9879, 9880, 9881, 9882, 9883, 9884, 9885]

packages/mcp-server/src/bridge.ts:174
  for (const port of WS_PORT_RANGE)        // server takes the first FREE port

packages/extension/src/core/connection-manager.ts:11
  "We probe all ports in parallel and hold every agent we find."
```

So *N* concurrently running MCP servers become *N* independently discovered agents. Every one
of them is a separate approval.

That is fine, and intended, for a handful. It stops being fine when the server is installed at
**user scope**, because then **every editor/agent session spawns one**. Measured on this machine:

- `~/.claude.json` top-level `mcpServers.onbridge` → user scope, inherited by every session
- **6 Claude Code sessions running** (ttys000, 001, 002, 005, 010, 012)
- Ten ports in range, so up to ten servers before exhaustion

One user-scope install silently converts "one agent" into "one agent per terminal tab".

### Why this also explains Bug 1

All servers share one `~/.onbridge/`, so they share `server-key.json` (one `serverId`) **and one
`peers.json`, which is keyed by extension id alone** — not by (extension id, server instance) —
with no locking across processes.

Start several at once against an empty or freshly cleared `peers.json` and they race:

1. Each reads `peers.json`, finds no record, reports `paired: false`
2. The extension therefore prompts **once per server**  ← the reported noise
3. Each approval derives a *different* secret and writes it to the same key
4. Last writer wins; every earlier server's secret is now orphaned in the extension
5. The next connection from an earlier server fails `invalid auth proof` ← **Bug 1**

The extension's stored `onbridge_pairings` on this machine held **three** successive secrets for
one `serverId`, none matching `peers.json`. That is exactly the fingerprint this race leaves.

### What is verified vs. not

**Verified:** the port range, the first-free-port bind, the probe-all-and-hold-every-agent
comment, user scope in `~/.claude.json`, 6 concurrent sessions, and the three orphaned secrets.

**Not verified:** the prompts are *not visible* in the attached recording. Thirty frames sampled
across its 449 seconds all show a healthy single-agent panel (one Claude Code, pid 65809, port
9876, encrypted, this window). The recording begins at 15:17:09; pairing completed at 15:14:32,
so the prompt storm preceded it. The recording is attached as evidence of the **healthy** state
and of the session it came from, not as a capture of the defect. Worth re-recording from the
moment Control Mode is switched on with several sessions live.

Also unexplained and possibly related: `peers.json` shows `pairedAt == lastSeen` exactly
(`1789897472338`, 15:14:32) while dozens of commands ran successfully afterwards. `lastSeen`
never advanced past the pairing itself, so it cannot be used to tell a live pairing from a stale
one — which is a shame, because Bug 1's message asserts a claim that this field ought to settle.

### Suggested fixes

1. **Key `peers.json` by (extension id, serverId or instance id)**, and take a lock around
   read-modify-write. Two agents must not be able to clobber each other.
2. **Coalesce the prompt.** One approval per *extension*, not per server instance, or a single
   prompt listing every agent found in one sweep with one Allow.
3. **Warn on user-scope install** — if the server sees siblings on other ports in the range, log
   it and surface it in the panel, rather than letting the count grow silently.
4. **Update `lastSeen`** on every successful authentication.

**Resolution — FIXED in v0.4.0** (`74fb17b`), all four, plus the identity race described under Bug 1.

1. `peers.json` is v2: keyed by `(extensionId, serverId)`, written under an advisory directory
   lock with stale-lock breaking. A v1 flat map is migrated on read and only rewritten on the
   next write, so an existing pairing survives the upgrade and an older build can still read an
   untouched file.
2. Coalesced at the source rather than in the UI. `claimPairing` takes a cross-process lock
   before prompting; siblings wait, then find the record the winner wrote and authenticate
   against it. **N concurrent servers cost one approval and all of them end up working.** The
   lock is released only after promotion, so a waiting sibling cannot read a half-written
   pairing.
3. The server counts listening siblings at startup and logs the user-scope explanation past
   three; the panel shows the same hint once it has discovered three or more agents.
4. `lastSeen` is forced on every successful authentication and touched (throttled to once a
   minute) on the heartbeat, so it can now distinguish a live pairing from a stale one.

Covered by `packages/mcp-server/test/pairing-race.test.ts` — two real servers sharing one
`~/.onbridge`, handshaking concurrently from an empty store — and
`packages/mcp-server/test/peer-store.test.ts`.

### Attachments

A screen recording and panel stills were captured while investigating this. They showed the
*healthy* state — the recording began three minutes after pairing completed, so the prompt
storm preceded it — and were reference material only. They are **not** in the repository, and
`docs/evidence/` is git-ignored so no future capture is committed by accident.
