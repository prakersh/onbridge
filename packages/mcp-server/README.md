# onbridge

**Browser control for AI agents — an MCP server that drives your real Chrome, through a companion extension.**

OnBridge connects agents (Claude Code, Codex, Cursor, …) to the browser you already
use — your sessions, your logins, your extensions — over the
[Model Context Protocol](https://modelcontextprotocol.io).

This package is the **MCP server**. It needs the **Chrome extension** to do anything;
on its own it is half a bridge.

| | |
|---|---|
| [Chrome Web Store](https://chromewebstore.google.com/detail/onbridge/minhhfibhfnjdcgiipmcbfgclmeineca) | the extension |
| [github.com/prakersh/onbridge](https://github.com/prakersh/onbridge) | full documentation, architecture, security model, contributing |

---

## Install

Add this to your agent's MCP config:

```json
{
  "mcpServers": {
    "onbridge": {
      "command": "npx",
      "args": ["-y", "@onllm-dev/onbridge-mcp"],
      "type": "stdio"
    }
  }
}
```

Then install the extension from the Chrome Web Store and click its toolbar icon to
open the side panel. Nothing is installed globally — `npx` fetches the server on
first run.

### First run

1. Open the side panel and turn on **Control Mode**.
2. The panel asks once whether to let the agent connect. It names the agent, its
   process id and the project directory it is running in, so you know which session
   you are approving.
3. Press **Give this agent control**. It now drives the window the panel is in.
4. Every later session connects silently — one toggle, no tokens, no config editing.

---

## What it does

**Real input.** Clicks and keystrokes are dispatched through the Chrome DevTools
Protocol, so they arrive with `isTrusted: true`. Synthetic DOM events are rejected by
native form submission, drag-and-drop, canvas apps, and anti-bot checks.

**A governance layer.** Actions that spend money, delete things, or read credentials
are held for your approval, and approvals fail closed. Page content is fenced as
untrusted so a hostile page cannot instruct the agent. You choose the tab scope,
restrict the agent to named domains, and can pause it at any moment.

**An authenticated, encrypted channel.** The server binds loopback and speaks to the
extension over ECDH + AES-256-GCM. Pairing secrets are derived, never transmitted.
The extension is the trust boundary; every policy decision lives there, not here.

38 tools, grouped: observe (`snapshot`, `find`, `extract_text`), interact (`click`,
`type`, `fill_form`), navigate, tabs, advanced (`evaluate`, `get_cookies`,
`console_logs`), and session (`ask_user`, `bridge_status`). Ask your agent to run
`bridge_status` to check the connection.

---

## Good to know

- **Installing at user scope starts one server per editor session.** They share the
  browser, but only ten loopback ports are scanned — past ten concurrent sessions no
  new agent can connect. Configure per project if you did not mean to run an agent
  everywhere.
- **A performed action is never reported as a failure.** If a click lands but the
  page cannot be captured afterwards, the call still succeeds and tells you why.
  Never retry a click on an error; it may already have happened.
- **Reading a page is cheaper than snapshotting it.** `extract_text` for reading,
  `snapshot` for acting.

---

## Configuration

| Variable | Purpose |
|---|---|
| `ONBRIDGE_EXTENSION_ID` | Restrict the Origin allowlist to one extension id. The published extension's id is `minhhfibhfnjdcgiipmcbfgclmeineca`. |
| `ONBRIDGE_DEV_EXTENSION_IDS` | Extra ids allowed during development (comma-separated). |
| `ONBRIDGE_AGENT_NAME` | Name shown in the pairing prompt. |
| `ONBRIDGE_HOME` | Override `~/.onbridge`. |

With no id configured, any `chrome-extension://` origin is accepted and a warning is
logged. Web pages are still rejected.

---

## License

GPL-3.0-only. See [LICENSE](https://github.com/prakersh/onbridge/blob/main/LICENSE).
