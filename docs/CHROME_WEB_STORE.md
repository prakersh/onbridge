# Chrome Web Store submission

Everything needed for the listing, plus the steps that must happen in a specific
order. Read the "extension ID" section before the first upload — it is the one
step that cannot be redone later without breaking existing users.

---

## Permission justifications

Reviewers reject vague answers. These are specific on purpose; paste them into
the corresponding fields.

### `debugger` — the one that draws scrutiny

> OnBridge dispatches user input through the Chrome DevTools Protocol so that
> clicks and keystrokes are genuine trusted events. Synthetic DOM events
> (`dispatchEvent`) are rejected by native form submission, drag-and-drop,
> canvas-based editors, and most modern web applications, which makes the
> extension unable to perform its core function without this permission. It is
> also the only way to read a page's console output and capture full-page
> screenshots. The debugger is attached only while the user has explicitly
> enabled Control Mode, and is detached the moment it is turned off. Chrome's
> "started debugging this browser" banner is left visible deliberately, as
> unspoofable notice to the user that automation is active.

### `cookies`

> The agent needs to determine whether the user is already signed in to a site
> in order to decide what to do next. By default OnBridge returns only cookie
> names, domains and flags — never values. Values are returned only when the
> user explicitly approves that specific request through an in-extension prompt.

### `<all_urls>` (host permissions)

> The user chooses at run time which site the agent should operate on, so the
> set of hosts cannot be known in advance. Content scripts read page structure
> only while Control Mode is enabled and only within the tab scope the user
> selected (current tab, current window, or all tabs). The user can further
> restrict operation to a named list of domains.

### `tabs`

> To list open tabs for the agent, switch between them, and read the URL of the
> page being acted on. Restricted by the user's chosen access scope.

### `scripting`

> To inject the content script that reads page structure into the tab the user
> has authorised.

### `webNavigation`

> To enumerate the frames of a page so that content inside iframes (embedded
> checkouts, editors, sign-in widgets) can be read and interacted with. Without
> it, iframe content is invisible to the agent.

### `downloads`

> To download a file when the user's task requires it, and to report the status
> and resulting path back to the agent.

### `storage`

> To persist the user's preferences (Control Mode, access scope, domain policy)
> and the pairing secret that authenticates the local connection. Nothing is
> transmitted off the device.

### `sidePanel`

> The extension's entire interface is a side panel: connection status, approval
> prompts, questions from the agent, and a live log of every action taken.

### `notifications`

> To alert the user when the agent is blocked waiting for an approval or an
> answer and the side panel is not open, and when Control Mode is revoked for
> inactivity.

### `activeTab`

> Used together with the access-scope control so that, in the default mode, the
> agent can act only on the tab that was active when the user enabled Control
> Mode.

---

## Single purpose

> OnBridge lets an AI agent running on the user's own computer control their
> browser — reading pages and performing actions such as clicking, typing and
> navigating — under the user's explicit, revocable authorisation.

---

## Remote code

**No remote code is used.** All logic ships inside the package. The extension
loads no scripts from any URL and evaluates no code fetched at runtime.

The `evaluate` tool runs JavaScript that the local agent supplies, inside the
page context. This is functionally identical to the user typing into DevTools:
it is initiated by a program on the user's own machine, over a loopback
connection, and it requires explicit per-call user approval. It is not code
fetched from a remote server by the extension.

---

## Data usage disclosures

| Question | Answer |
|---|---|
| Collects personally identifiable information | No |
| Collects health information | No |
| Collects financial information | No |
| Collects authentication information | No — cookie values require per-request user approval and are sent only to the user's own local machine |
| Collects personal communications | No |
| Collects location | No |
| Collects web history | No |
| Collects user activity | No |
| Collects website content | Yes — transmitted only to a process on the user's own computer over `127.0.0.1` |

Certifications to tick:

- Data is not sold to third parties. ✅
- Data is not used for purposes unrelated to the single purpose. ✅
- Data is not used to determine creditworthiness or for lending. ✅

Privacy policy URL: `https://github.com/prakersh/onbridge/blob/main/PRIVACY.md`

---

## Extension ID — do this before the first upload

The Origin allowlist in the MCP server is keyed to the extension's ID, so the ID
must be settled before release.

With no ID configured the server accepts **any** `chrome-extension://` origin
and logs a warning. Web pages are still rejected, so this is safe for
development but too permissive to ship.

**Order of operations:**

1. Upload the first build to the Web Store. Chrome assigns the ID at this point;
   it cannot be chosen in advance.
2. Copy the assigned ID from the developer dashboard.
3. Set it as the default in `packages/mcp-server/src/identity.ts`, or document
   `ONBRIDGE_EXTENSION_ID` for users.
4. Copy the item's public key from the dashboard into `manifest.key` via
   `wxt.config.ts`, so unpacked development builds share the published ID.
5. Release the MCP server **after** step 3, so the published server and the
   published extension agree.

Getting this wrong in the other order means a server that rejects the very
extension it shipped with.

---

## Pre-submission checklist

- [ ] `./app.sh --build` clean
- [ ] `pnpm typecheck` — zero errors across all three packages
- [ ] `pnpm test` — 48 passing
- [ ] `pnpm test:browser` — 25 passing
- [ ] `ONBRIDGE_EXTENSION_ID` set, or a documented default (see above)
- [ ] Version bumped via `./app.sh --bump`
- [ ] Screenshots: side panel connected; an approval prompt; the activity feed
- [ ] Privacy policy URL reachable
- [ ] Store zip built via `./app.sh --package`

---

## Review risk

The `debugger` permission is the highest-scrutiny item in this manifest and the
most likely cause of a rejection or a follow-up question. Two things reduce that
risk: the justification above states plainly why the extension cannot function
without it, and the extension degrades rather than breaks if it is refused —
when the debugger cannot attach, input falls back to synthetic events and the
side panel tells the user that fidelity is reduced.

If review pushes back, that fallback is the argument: the permission buys
correctness on real sites, not capability the extension otherwise lacks.
