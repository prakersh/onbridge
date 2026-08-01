# onbridge

Browser control execution layer — MCP server + Chrome extension that lets any AI agent control the user's real browser.

## Architecture

```
Agent (Claude Code, Codex, etc.) ↔ stdio/MCP ↔ MCP Server ↔ WebSocket (localhost:9876) ↔ Extension Background ↔ Content Script ↔ DOM
```

## Project Structure

- `packages/shared/` — Protocol types, DOM types, serializer
- `packages/mcp-server/` — MCP server with stdio transport + WebSocket bridge
- `packages/extension/` — Chrome Extension (MV3, WXT framework)

## Development

```bash
# Install dependencies
pnpm install

# Build everything
pnpm build

# Dev mode (parallel)
pnpm dev
```

### MCP Server
```bash
cd packages/mcp-server
pnpm dev          # Run with tsx --watch
pnpm build        # Build for distribution
```

### Extension
```bash
cd packages/extension
pnpm dev          # Dev mode with HMR
pnpm build        # Production build → .output/chrome-mv3/
```

## Loading the Extension

1. Build: `cd packages/extension && pnpm build`
2. Open Chrome → `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked" → select `packages/extension/.output/chrome-mv3/`

## Configuring MCP

Add to your agent's MCP settings:
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

Or for local development:
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

## Tech Stack

- **MCP Server**: Node.js, TypeScript, `@modelcontextprotocol/server`, `ws`, `zod/v4`
- **Extension**: WXT, React, Tailwind CSS, TypeScript
- **Shared**: TypeScript, `tsup`
- **Workspace**: pnpm workspaces

## Key Files

- `packages/extension/src/core/dom-capture.ts` — DOM distillation engine (token-efficiency core)
- `packages/extension/src/core/command-executor.ts` — Executes browser commands
- `packages/extension/src/entrypoints/background.ts` — WebSocket client + command router
- `packages/mcp-server/src/bridge.ts` — WebSocket server for extension comms
- `packages/mcp-server/src/server.ts` — MCP server + tool registration
- `packages/shared/src/serializer.ts` — Compact snapshot text format
