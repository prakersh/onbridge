# onbridge

**Browser control for AI agents — an MCP server that drives your real Chrome, through a companion extension.**

OnBridge connects agents (Claude Code, Codex, Cursor, …) to the browser you already use — your sessions, your logins, your extensions — over the [Model Context Protocol](https://modelcontextprotocol.io).

This package is the **MCP server**. It needs the **Chrome extension** to do anything; on its own it is half a bridge.

| | |
|---|---|
| [Chrome Web Store](https://chromewebstore.google.com/detail/onbridge/minhhfibhfnjdcgiipmcbfgclmeineca) | the extension |
| [github.com/prakersh/onbridge](https://github.com/prakersh/onbridge) | full documentation, architecture, security model, contributing |

---

## Install

Add this to your agent's MCP config. Ready-to-paste setup for Claude Code, Codex, Gemini CLI, Cursor, VS Code and Claude Desktop is in the [Quick Start](https://github.com/prakersh/onbridge#quick-start) guide.

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

There is nothing else to configure. The server accepts only the official OnBridge extension, so no other extension on the machine can connect to it.

Then install the extension from the [Chrome Web Store](https://chromewebstore.google.com/detail/onbridge/minhhfibhfnjdcgiipmcbfgclmeineca) and click its toolbar icon to open the side panel. Requires Node.js 20 or later. Nothing is installed globally — `npx` fetches the server on first run.

### First run

1. Open the side panel and turn on **Control Mode**.
2. Ask your agent to use the browser. It connects the first time it needs to, so sessions that never use OnBridge stay out of the panel.
3. The first time, the panel asks whether to let the agent connect. It shows the agent's name, project folder and a short connection code, which the agent shows too. Press **Allow and give control**: it now drives the window the panel is in.
4. Later sessions connect without asking again, and wait until you press **Give this agent control**.

---

## What it does

**Real input.** Clicks and keystrokes are dispatched through the Chrome DevTools Protocol, so they arrive with `isTrusted: true`. Synthetic DOM events are rejected by native form submission, drag-and-drop, canvas apps, and anti-bot checks.

**A governance layer.** Actions that spend money, delete things, or read credentials are held for your approval, and approvals fail closed. Page content is fenced as untrusted so a hostile page cannot instruct the agent. You choose the tab scope, restrict the agent to named domains, and can pause it at any moment.

**An authenticated, encrypted channel.** The server binds loopback and speaks to the extension over ECDH + AES-256-GCM. Pairing secrets are derived, never transmitted. The extension is the trust boundary; every policy decision lives there, not here.

40 tools, grouped: observe (`snapshot`, `find`, `extract_text`), interact (`click`, `type`, `fill_form`), navigate, tabs, advanced (`evaluate`, `get_cookies`, `console_logs`, `network_requests`), and session (`ask_user`, `bridge_status`). Ask your agent to run `bridge_status` to check the connection.

---

## Good to know

- **An agent connects to the browser the first time it uses OnBridge,** not when it starts, so sessions that never touch the browser stay out of the side panel. The browser holds at most ten connected agents; set `ONBRIDGE_CONNECT=startup` to connect at startup instead.
- **A performed action is never reported as a failure.** If a click lands but the page cannot be captured afterwards, the call still succeeds and tells you why. Never retry a click on an error; it may already have happened.
- **Reading a page is cheaper than snapshotting it.** `extract_text` for reading, `snapshot` for acting.
- **Refused with `already paired with a different extension`?** See [Troubleshooting](https://github.com/prakersh/onbridge#troubleshooting).

---

## Configuration

| Variable | Purpose |
|---|---|
| `ONBRIDGE_EXTENSION_ID` | Accept this extension instead of the official one (`minhhfibhfnjdcgiipmcbfgclmeineca`). Needed only for a build with a different id, such as a Release zip. |
| `ONBRIDGE_DEV_EXTENSION_IDS` | Extra extension ids to accept, comma-separated. |
| `ONBRIDGE_ALLOW_ANY_EXTENSION` | Set to `1` to accept any extension and pin the first one to pair. For development only. |
| `ONBRIDGE_CONNECT` | Set to `startup` to connect to the browser as soon as the agent starts, instead of on its first use of OnBridge. |
| `ONBRIDGE_AGENT_NAME` | Name shown in the pairing prompt. |
| `ONBRIDGE_HOME` | Override `~/.onbridge`. |

Web pages are always rejected, whatever is configured.

---

## License

GPL-3.0-only. See [LICENSE](https://github.com/prakersh/onbridge/blob/main/LICENSE).
