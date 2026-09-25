# Contributing to OnBridge

Thanks for taking the time. OnBridge lets an AI agent drive a real, signed-in browser, so most of what makes a change good or bad here is about trust: what a web page can reach, what the agent is allowed to do without asking, and what the user can see. This guide covers how to report problems, how to get a working setup, and the rules a change must not break.

## Reporting a bug

Open an [issue](https://github.com/prakersh/onbridge/issues) with:

- what you asked the agent to do, what happened, and what you expected
- the output of the `bridge_status` tool (ask your agent to run it)
- versions: the extension's (shown at `chrome://extensions/`), the MCP server's (the latest npm release unless you pinned one), Chrome's, your OS, and which agent you use
- whether the extension came from the Chrome Web Store, a Release zip, or a local build

Never paste the contents of `~/.onbridge/` or the extension's storage. They hold pairing secrets.

## Reporting a security problem

Please do **not** open a public issue. Email **[prakersh@live.com](mailto:prakersh@live.com)** with what you found and how to reproduce it, and we will get back to you.

In scope is anything that breaks the model described in [How OnBridge keeps you in control](docs/security.md), for example:

- a web page reaching or influencing the bridge
- an action going through without the approval its risk class requires, or reaching a domain the user blocked
- page content escaping the untrusted-content fence and reading to the agent as trusted text
- a pairing secret reaching the agent's context or a tool result

Out of scope, as that page says plainly: malware already running as the user. It can read the pairing secrets directly, and no design here claims otherwise.

## Development setup

You need Node.js 20 or later, [pnpm](https://pnpm.io) 10, and Chrome.

```bash
pnpm install
./app.sh --build          # shared, then mcp-server, then extension
```

| Package | What lives there |
|---|---|
| `packages/shared` | Protocol types, crypto and handshake, snapshot serializer |
| `packages/mcp-server` | The MCP server (stdio) and the encrypted WebSocket bridge |
| `packages/extension` | The Chrome MV3 extension (WXT): DOM capture, CDP input, policy, side panel |

### Running your build

Load `packages/extension/.output/chrome-mv3/` unpacked at `chrome://extensions/` with Developer mode on, or run `pnpm dev` in `packages/extension` for a live-reloading build.

Point your agent at the server source rather than the published package:

```json
{
  "mcpServers": {
    "onbridge": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/onbridge/packages/mcp-server/src/index.ts"],
      "type": "stdio"
    }
  }
}
```

A local build carries the store item's public key, so it has the same extension id as the Web Store version, `minhhfibhfnjdcgiipmcbfgclmeineca`. That is the id the server accepts by default, so your build connects with no extra configuration. Chrome holds one or the other, not both.

After changing server code, the agent's running server has to exit before it picks the change up: reconnecting from the agent (for example `/mcp` in Claude Code) may reattach to the process that is still running. Restart the agent session, or stop that server process and reconnect.

Your agent connects to the browser when it first calls an OnBridge tool. Set `ONBRIDGE_CONNECT=startup` to have it appear in the panel as soon as it starts, which is what the test harnesses do, since they pair before calling anything.

To work with a build that has a different id, set `ONBRIDGE_ALLOW_ANY_EXTENSION=1` in the server's environment. The server then accepts any extension and pins the first one to pair; it logs a warning so the mode is never on by accident. Switching extensions in that mode needs `~/.onbridge/peers.json` deleted — see [Troubleshooting](README.md#troubleshooting). The unit and integration suites run in this mode because they pair fixture ids.

### Tests

Run all three before opening a pull request:

```bash
./app.sh --build          # the integration suite spawns the built server binary
pnpm typecheck            # all three packages
pnpm test                 # unit and integration (vitest)
pnpm test:browser         # end to end, in a real browser
```

`pnpm test` starts its throwaway MCP servers on ports 19876–19885, which the extension never scans, so the suites neither disturb the agents in your own browser nor fail because those agents hold the usual ports.

`pnpm test:browser` loads the built extension into Playwright's bundled Chromium, pairs it, and asserts what the page actually observed: trusted events, shadow DOM, iframes, approval gating, several agents on several windows. It then runs `scripts/verify-multi-browser.mjs`: two browser profiles and one agent with default settings, checking that the agent connects on its first tool call, that each profile pairs on its own, and that commands follow whichever browser granted control last. Together they are the only suites that cover pairing and the domain guards end to end, and CI does not run it, so run it locally. It uses Chromium rather than Chrome because current Chrome releases ignore `--load-extension`. Both run on ports 19876–19885 in both directions: their servers listen there and their test browsers are told to scan only there, so they never touch your own browser or your running agents. If Chromium is missing, install it with `pnpm exec playwright-core install chromium`.

A behaviour change needs a test that fails without it. The browser suite occasionally has a flaky run; re-run it once before treating a single failure as real.

## Rules a change must not break

Each of these exists because breaking it caused a real bug or a real hole. Changing one needs a deliberate decision in the pull request, not a drive-by edit.

- **The bridge binds `127.0.0.1` and checks `Origin`.** Browsers do not apply CORS to WebSockets, so any page you visit could otherwise reach the port. By default only the official extension id is accepted; accepting any extension is an explicit development mode, never a fallback.
- **The pairing secret is derived, never transmitted,** and never enters the agent's context or a tool result.
- **Policy is enforced in the extension.** The extension is the trust boundary; anything checked only in the server is advice.
- **Approvals fail closed.** No answer means denied.
- **The approval mode is settable only from the extension's own pages.** There is deliberately no MCP tool for it: an agent that can widen its own permissions makes every prompt theatre. Domain allow and deny lists apply in every mode, Bypass included.
- **Every action is classified deliberately** in `packages/extension/src/core/policy.ts`. `packages/extension/test/policy.test.ts` checks that nothing falls through to the default.
- **Anything a page can influence goes through `pageText`**, in `packages/mcp-server/src/tools/reply.ts`, never `text`. That includes tab titles, console output, cookie names, `evaluate` output and error messages, since a page can throw whatever it likes. `packages/mcp-server/test/injection.test.ts` covers every such tool.
- **An agent controls nothing until the user grants it a scope,** and grants may not overlap. The target tab is resolved once, in `handleCommand`; handlers must not fall back to Chrome's "current window". See `packages/extension/test/scope.test.ts`.
- **Domain lists are checked before dispatch, after it, and at the network layer.** Each check covers a path the others cannot see: a destination the agent names, a navigation the page starts, and a `fetch()` from `evaluate`.
- **A performed action is never reported as a failure.** An agent told that a click failed will retry it, and a retried click is how an order gets placed twice.
- **Frame handling is serialised, in both directions,** and `bridge.ts` never uses `this.session` after an `await` without checking it again. The handshake derives keys the next frame needs, and the replay guard rejects out-of-order counters.
- **The server may be newer than the extension.** The MCP server reaches users with every npm release; the extension waits on Web Store review. Put new behaviour in the server where it can live there, make protocol additions optional fields, and never change `HANDSHAKE_VERSION` in the server alone. A new command needs the extension too, and an older extension refuses it with a clear "update the extension" message rather than failing obscurely.
- **Pairing requests queue; they never cancel each other,** and **the browser the user picks wins**: approving an agent in one browser withdraws its request from the others, and granting control in one takes it back from the browser that had it.
- **The server exits when its agent does.** Otherwise every finished session leaves a process holding one of the ten ports.

## Commits and pull requests

Commits follow [Conventional Commits](https://www.conventionalcommits.org) with a scope where one fits: `feat(extension): …`, `fix(panel): …`, `docs: …`. The body says *why*: what was wrong, what the change does about it, and anything a reviewer would otherwise have to rediscover.

A pull request should:

- pass the three test commands above
- add or update tests for the behaviour it changes
- update the README, or this file, when user-visible behaviour or a rule above changes

## Releasing

For maintainers. The version is set in a normal PR, and a release tags what was merged:

```bash
./app.sh --bump minor           # in the PR: VERSION and every package.json (or: patch, major)
./app.sh --release              # after merging: start the Release workflow on GitHub
```

Releases run on GitHub, never from a local machine. `./app.sh --release` checks that the version on `main` is not released yet and that every `package.json` matches `VERSION`, then starts `.github/workflows/release.yml`; the **Run workflow** button in the Actions tab does the same. The workflow tags the `main` commit with `v<VERSION>`, builds the GitHub release with the extension zip and the server tarball, and publishes the npm package. The Chrome Web Store upload is separate: the extension zip from the release, uploaded with `./app.sh --store release --zip <zip>` on a machine with store credentials, or by hand. The store credentials live outside the repository and are set up once with `./app.sh --store auth`; [docs/CHROME_WEB_STORE.md](docs/CHROME_WEB_STORE.md) has the full procedure and the listing material.

[`.github/workflows/release.yml`](.github/workflows/release.yml) builds the artifacts, attaches them to a GitHub Release, and publishes `@onllm-dev/onbridge-mcp` to npm. The npm job authenticates with GitHub OIDC through a Trusted Publisher entry on the package, so there is no stored token, and it is not a dependency of the GitHub Release: a failed publish never withholds the release or its artifacts.

Other `app.sh` commands: `--build`, `--dev`, `--clean`, `--typecheck`, `--version`, `--bump <part>`, `--package`, `--store <auth|status|upload|publish|release>`. Run `./app.sh --help` for details.

## License

OnBridge is licensed under [GPL-3.0-only](LICENSE). By contributing, you agree that your contributions are licensed under the same terms.
