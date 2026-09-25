# Tools

OnBridge exposes 40 tools over MCP. Your agent chooses among them on its own; this page is for people who want to know what they do, or who are writing prompts and agents around them.

| Group | Tools |
|---|---|
| Observe | `snapshot` · `find` · `extract_text` · `list_actions` · `get_text` · `get_url` · `screenshot` · `highlight` |
| Interact | `click` · `click_by_text` · `type` · `fill_form` · `select` · `hover` · `scroll` · `press_key` · `drag` · `upload` · `dismiss_modal` |
| Navigate | `navigate` · `back` · `forward` · `reload` · `wait` |
| Tabs | `list_tabs` · `switch_tab` · `new_tab` · `close_tab` |
| Advanced | `evaluate` · `dom_query` · `get_cookies` · `set_cookie` · `console_logs` · `network_requests` · `network_request_body` · `download_file` · `list_downloads` · `activity_log` |
| Session | `ask_user` · `bridge_status` |

Which of these ask for your approval is covered in [How OnBridge keeps you in control](security.md#what-the-agent-may-do).

## Behaviour worth knowing

- **A performed action is never reported as a failure.** `click`, `click_by_text`, `scroll`, `dismiss_modal` and `navigate` return `{ ok, navigated, url, title, snapshot? }`. If the action ran but the page could not be captured afterwards — the usual case when a click navigates — the call still succeeds, says why there is no snapshot, and gives you the new URL. Never retry a click on an error: it may already have happened.
- **Reading a page cheaply.** `extract_text` is the cheap way to *read* (tables come back as markdown); `snapshot` is for *acting*. `find` is cheaper still when you know what you are looking for. On a heavy page the snapshot is most of the cost of a `navigate`, so `navigate(url, snapshot: false)` followed by `find` or `extract_text` is the cheap pattern; `compact` and `depth` work there too.
- **Following a link without clicking it.** `find` and `dom_query` report absolute hrefs, and `dom_query` has an `attr` action. Reading a result's destination and navigating to it directly avoids the most failure-prone thing the bridge does.
- `extract_text` distinguishes "no such ref", "this element is genuinely empty" and the text itself. It never answers a scoped read with a bare empty string.
- `list_actions` answers "what can I do here?" for a fraction of a snapshot.
- Shadow DOM and iframes are captured. Refs are frame-qualified automatically, and clicks and typing inside an iframe are real trusted input — including cross-origin frames, which run in their own process.
- A lost ref is re-resolved from a recorded locator instead of failing outright.
- A page caught between documents returns a typed, retryable error rather than Chrome's raw *"Could not establish connection"*, so a retry is distinguishable from a refusal.
- `navigate` tells you when it landed on a different origin than you asked for.
- `bridge_status` answers even before the agent has been given control, and reports the connection code the user should look for in the panel.
- `get_url` reads Chrome's tab list, so it works on `chrome://` pages and the New Tab page, where tools that read the page itself cannot run.
- A command the installed extension is too old to run is refused up front, with a message saying the extension needs updating, rather than failing obscurely.
