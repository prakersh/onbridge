#!/usr/bin/env bash
#
# OnBridge MCP Server - One-Click Installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/prakersh/onbridge/main/install.sh | bash
#
# What it does:
#   1. Downloads the latest release from GitHub
#   2. Installs to ~/.onbridge/
#   3. Installs dependencies
#   4. Prints MCP config to add to your AI agent
#
# SPDX-License-Identifier: GPL-3.0-only

set -euo pipefail

# ── Config ──

REPO="prakersh/onbridge"
INSTALL_DIR="$HOME/.onbridge"
BIN_NAME="onbridge"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

log()  { echo -e "$@"; }
info() { echo -e "${CYAN}>>>${NC} $*"; }
ok()   { echo -e "${GREEN}>>>${NC} $*"; }
warn() { echo -e "${YELLOW}>>>${NC} $*"; }
err()  { echo -e "${RED}>>>${NC} $*" >&2; }

# ── Preflight ──

check_deps() {
  local missing=()
  command -v curl  &>/dev/null || missing+=(curl)
  command -v tar   &>/dev/null || missing+=(tar)
  command -v node  &>/dev/null || missing+=(node)
  command -v npm   &>/dev/null || missing+=(npm)

  if [[ ${#missing[@]} -gt 0 ]]; then
    err "Missing required tools: ${missing[*]}"
    err "Please install them and try again."
    exit 1
  fi

  local node_major
  node_major=$(node -v | sed 's/v//' | cut -d. -f1)
  if [[ "$node_major" -lt 20 ]]; then
    err "Node.js >= 20 required (found $(node -v))"
    exit 1
  fi
}

# ── Fetch latest release ──

get_latest_version() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' \
    | sed -E 's/.*"tag_name":\s*"v([^"]+)".*/\1/'
}

# ── Install ──

main() {
  log ""
  log "  ${BOLD}OnBridge MCP Server Installer${NC}"
  log "  ${DIM}Browser control for AI agents${NC}"
  log ""

  check_deps

  info "Fetching latest release..."
  local version
  version=$(get_latest_version)
  if [[ -z "$version" ]]; then
    err "Could not determine latest version"
    exit 1
  fi
  ok "Latest version: v${version}"

  local tarball_url="https://github.com/${REPO}/releases/download/v${version}/onbridge-mcp-server-v${version}.tar.gz"
  local tarball_name="onbridge-mcp-server-v${version}"

  # Clean previous install
  if [[ -d "$INSTALL_DIR" ]]; then
    warn "Existing installation found at $INSTALL_DIR"
    info "Removing old installation..."
    rm -rf "$INSTALL_DIR"
  fi

  mkdir -p "$INSTALL_DIR"

  info "Downloading v${version}..."
  curl -fsSL "$tarball_url" | tar -xz -C "$INSTALL_DIR" --strip-components=1

  info "Installing dependencies..."
  (cd "$INSTALL_DIR" && npm install --production --silent 2>/dev/null)

  # Create launcher script
  cat > "$INSTALL_DIR/run.sh" <<'LAUNCHER'
#!/usr/bin/env bash
exec node "$(dirname "$0")/dist/index.js" "$@"
LAUNCHER
  chmod +x "$INSTALL_DIR/run.sh"

  # ── Success ──

  log ""
  ok "${BOLD}OnBridge MCP Server v${version} installed!${NC}"
  log ""
  log "  ${DIM}Location:${NC} $INSTALL_DIR"
  log ""
  log "  ${BOLD}Add this to your MCP client config:${NC}"
  log ""
  log "  ${DIM}(Claude Desktop, Cursor, Windsurf, etc.)${NC}"
  log ""
  log "  ${CYAN}{"
  log "    \"mcpServers\": {"
  log "      \"onbridge\": {"
  log "        \"command\": \"${INSTALL_DIR}/run.sh\","
  log "        \"type\": \"stdio\""
  log "      }"
  log "    }"
  log "  }${NC}"
  log ""
  log "  ${DIM}Or use node directly:${NC}"
  log ""
  log "  ${CYAN}{"
  log "    \"mcpServers\": {"
  log "      \"onbridge\": {"
  log "        \"command\": \"node\","
  log "        \"args\": [\"${INSTALL_DIR}/dist/index.js\"],"
  log "        \"type\": \"stdio\""
  log "      }"
  log "    }"
  log "  }${NC}"
  log ""
  log "  ${DIM}Don't forget to install the Chrome extension too!${NC}"
  log "  ${DIM}https://github.com/${REPO}/releases${NC}"
  log ""
}

main "$@"
