# 🌉 OnBridge

**Browser control execution layer - MCP server + Chrome extension that lets any AI agent control the user's real browser.**

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

OnBridge connects AI agents (Claude Code, Codex, Cursor, etc.) to your real browser via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). It captures a token-efficient DOM snapshot, routes commands over WebSocket, and executes actions - clicks, typing, navigation, screenshots, and more - directly in Chrome.

---

## Architecture

```
AI Agent ↔ stdio/MCP ↔ MCP Server ↔ WebSocket (localhost:9876) ↔ Extension Background ↔ Content Script ↔ DOM
```

| Component | Description |
|---|---|
| **`packages/shared`** | Protocol types, DOM types, compact snapshot serializer |
| **`packages/mcp-server`** | MCP server (stdio transport) + WebSocket bridge to extension |
| **`packages/extension`** | Chrome Extension (Manifest V3, WXT framework) with DOM capture engine |

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 20
- **pnpm** (recommended: `corepack enable && corepack prepare pnpm@latest --activate`)
- **Chrome** or a Chromium-based browser

### Install & Build

```bash
# Clone the repo
git clone git@github.com:prakersh/onbridge.git
cd onbridge

# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### Development Mode

```bash
# Run everything in parallel (MCP server + extension dev)
pnpm dev
```

Or run packages individually:

```bash
# MCP Server - runs with tsx --watch for hot reload
cd packages/mcp-server && pnpm dev

# Extension - WXT dev mode with HMR
cd packages/extension && pnpm dev
```

---

## Loading the Chrome Extension

1. Build the extension: `cd packages/extension && pnpm build`
2. Open Chrome → navigate to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select `packages/extension/.output/chrome-mv3/`
5. Click the OnBridge extension icon and enable **Control Mode**

---

## Configuring MCP

Add OnBridge to your AI agent's MCP settings:

### Via npx (published package)

```json
{
  "mcpServers": {
    "onbridge": {
      "command": "npx",
      "args": ["-y", "onbridge"],
      "type": "stdio"
    }
  }
}
```

### Local development

```json
{
  "mcpServers": {
    "onbridge": {
      "command": "tsx",
      "args": ["packages/mcp-server/src/index.ts"],
      "type": "stdio"
    }
  }
}
```

---

## Available MCP Tools

OnBridge exposes a rich set of browser control tools to AI agents:

### 🧭 Navigation
- **`navigate`** - Go to a URL
- **`go_back` / `go_forward`** - Browser history navigation
- **`reload`** - Reload the current page

### 👁️ Observation
- **`snapshot`** - Capture a token-efficient DOM snapshot
- **`find`** - Search for text on the page
- **`screenshot`** - Take a full-page screenshot

### 🖱️ Interaction
- **`click`** - Click an element by reference
- **`type`** - Type text into an input field
- **`select_option`** - Select dropdown options
- **`scroll`** - Scroll the page or an element
- **`hover`** - Hover over an element

### 🗂️ Tab Management
- **`list_tabs`** - List all open tabs
- **`switch_tab`** - Switch to a specific tab
- **`new_tab`** - Open a new tab
- **`close_tab`** - Close a tab

### ⚡ Advanced
- **`evaluate`** - Execute JavaScript in the page context
- **`get_cookies`** - Retrieve cookies for a domain
- **`set_cookies`** - Set cookies

---

## Access Scopes

OnBridge supports three access scopes, configurable from the extension popup:

| Scope | Description |
|---|---|
| **Current Tab** | AI agent can only interact with the active tab |
| **This Window** | All tabs in the current browser window |
| **All Tabs** | Full browser access across all windows |

---

## Tech Stack

| Layer | Technologies |
|---|---|
| **MCP Server** | Node.js, TypeScript, `@modelcontextprotocol/server`, `ws`, `zod` |
| **Extension** | WXT, React, Tailwind CSS, TypeScript, Chrome Extension APIs (MV3) |
| **Shared** | TypeScript, `tsup` |
| **Workspace** | pnpm workspaces, TypeScript project references |

---

## Key Files

| File | Purpose |
|---|---|
| [`dom-capture.ts`](packages/extension/src/core/dom-capture.ts) | DOM distillation engine - the token-efficiency core |
| [`command-executor.ts`](packages/extension/src/core/command-executor.ts) | Executes browser commands from agent instructions |
| [`background.ts`](packages/extension/src/entrypoints/background.ts) | WebSocket client + command router |
| [`bridge.ts`](packages/mcp-server/src/bridge.ts) | WebSocket server bridging MCP ↔ extension |
| [`server.ts`](packages/mcp-server/src/server.ts) | MCP server setup + tool registration |
| [`serializer.ts`](packages/shared/src/serializer.ts) | Compact snapshot text format for token efficiency |

---

## `app.sh` - Build & Release Tooling

OnBridge uses a single `app.sh` script as the entry point for all build, dev, and release operations. The [`VERSION`](VERSION) file is the single source of truth for the project version.

```bash
# Make it executable (first time only)
chmod +x app.sh
```

| Command | Description |
|---|---|
| `./app.sh --build` | Build all packages in dependency order |
| `./app.sh --dev` | Start all packages in development mode |
| `./app.sh --clean` | Remove all build artifacts and generated files |
| `./app.sh --typecheck` | Run TypeScript type checking |
| `./app.sh --lint` | Run ESLint across all packages |
| `./app.sh --version` | Print current version from `VERSION` file |
| `./app.sh --bump <part>` | Bump version (`major`\|`minor`\|`patch`) and sync to all `package.json` |
| `./app.sh --package` | Build + package distributable artifacts into `./artifacts/` |
| `./app.sh --help` | Show help |

### Version Management

The `VERSION` file contains the version string (e.g., `0.1.0`). When you run `--bump`, it:
1. Increments the version in `VERSION`
2. Syncs it into all `package.json` files across the monorepo

```bash
./app.sh --bump patch   # 0.1.0 → 0.1.1
./app.sh --bump minor   # 0.1.0 → 0.2.0
./app.sh --bump major   # 0.1.0 → 1.0.0
```

---

## CI/CD

OnBridge uses GitHub Actions for continuous integration and releases.

### CI Pipeline (`.github/workflows/ci.yml`)

Runs on every push to `main` and on pull requests:
- ✅ TypeScript type checking
- ✅ Full production build (shared → mcp-server → extension)
- ✅ Build artifact verification

### Release Pipeline (`.github/workflows/release.yml`)

Triggered by pushing a `v*` tag. It:
1. Validates that `VERSION` file matches the tag
2. Builds and packages all artifacts via `./app.sh --package`
3. Uploads artifacts to GitHub Actions (90-day retention)
4. Creates a GitHub Release with the artifacts attached

### Creating a Release

```bash
# 1. Bump the version
./app.sh --bump minor

# 2. Commit the version change
git add -A
git commit -m "chore: bump version to $(cat VERSION)"

# 3. Tag the release
git tag "v$(cat VERSION)"

# 4. Push with tags
git push origin main --tags
```

This triggers the release pipeline, which produces:
- `onbridge-mcp-server-v<version>.tar.gz` - Standalone MCP server bundle
- `onbridge-extension-v<version>.zip` - Chrome extension (load unpacked)

---

## License

This project is licensed under the **GNU General Public License v3.0** - see the [LICENSE](LICENSE) file for details.

---

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

