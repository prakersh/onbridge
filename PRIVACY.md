# OnBridge Privacy Policy

_Last updated: 2026-08-03_

## The short version

OnBridge does not collect, transmit, or store your data on any server we control. There is no OnBridge server. Page content and browsing activity move between the extension and a program running on your own computer, over an encrypted connection on `127.0.0.1` that never leaves the machine.

## What OnBridge does

OnBridge lets an AI agent running on your computer control your browser. The extension reads page content and performs actions (clicking, typing, navigating) when that agent asks it to, and only while you have turned **Control Mode** on.

## What data is accessed

While Control Mode is on, and only within the tab scope you selected:

| Data | Why | Where it goes |
|---|---|---|
| Page content (text, structure, form values) | So the agent can understand and act on the page | The local agent, over `127.0.0.1` |
| The URL and title of pages in scope | So the agent knows where it is | The local agent |
| Screenshots, when requested | Visual verification | The local agent |
| Console output, when requested | Debugging | The local agent |
| Cookie **names and domains**, when requested | So the agent can tell whether you are signed in | The local agent |
| Cookie **values** | Only if the agent asks *and you explicitly approve* | The local agent |

**Passwords are never included.** Values of `input[type=password]` fields are replaced with a placeholder before any page data leaves the extension.

## Where your data goes

To one place: a process running on your own computer, reached over `ws://127.0.0.1`, bound to loopback so nothing on your network can connect. That process is the MCP server that your AI agent launched.

**Important and worth being clear about:** if your AI agent sends conversations to a cloud model (most do), then page content the agent reads may be included in what it sends to that provider. That transmission is done by your agent under its own privacy policy, not by OnBridge. OnBridge's job is to make sure it only happens with your consent and that you can see it happening.

## What OnBridge stores locally

| Item | Location | Contents |
|---|---|---|
| Pairing secrets | `chrome.storage.local` | A key per paired agent, used to authenticate the local connection |
| Preferences | `chrome.storage.local` | Control Mode, access scope, domain policy |
| Activity log | Extension memory only | The last 50 commands; cleared when the browser restarts |
| Server identity and peer records | `~/.onbridge/` (mode 0600) | Identifiers and pairing secrets on your filesystem |

None of it is transmitted anywhere. Removing the extension removes the extension-side data; deleting `~/.onbridge/` removes the rest.

## What OnBridge does not do

- No analytics, telemetry, crash reporting, or usage tracking.
- No advertising, and no selling or sharing of data — there is nothing collected to sell.
- No remote code loading. The extension runs only the code shipped in the package.
- Nothing runs while Control Mode is off.

## Your controls

- **Control Mode** — nothing is read or acted on while it is off.
- **Access scope** — restrict the agent to the current tab, the current window, or all tabs.
- **Approval prompts** — actions that read credentials or commit real-world consequences (purchases, deletions, sending) require your explicit approval, and are denied if you do not answer.
- **Domain restrictions** — limit the agent to named sites.
- **Pause** — stop all automation instantly while staying connected.
- **Idle revocation** — Control Mode turns itself off after 30 minutes of inactivity.

## Permissions

Each permission the extension requests is justified in [docs/CHROME_WEB_STORE.md](docs/CHROME_WEB_STORE.md).

## Children

OnBridge is a developer tool and is not directed at children under 13.

## Changes

Material changes will be noted in the repository changelog and reflected in the date above.

## Contact

Questions or concerns: https://github.com/prakersh/onbridge/issues
