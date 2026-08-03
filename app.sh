#!/usr/bin/env bash
#
# app.sh - OnBridge build, dev, and release tooling
#
# Usage:
#   ./app.sh --build          Build all packages for production
#   ./app.sh --dev            Start development mode (all packages)
#   ./app.sh --clean          Remove all build artifacts
#   ./app.sh --typecheck      Run TypeScript type checking
#   ./app.sh --lint           Run ESLint
#   ./app.sh --version        Print current version
#   ./app.sh --bump <part>    Bump version (major|minor|patch)
#   ./app.sh --package        Package artifacts for distribution
#   ./app.sh --help           Show this help message
#
# Copyright (C) 2025 OnBridge contributors
# SPDX-License-Identifier: GPL-3.0-only

set -euo pipefail

# ─── Constants ────────────────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION_FILE="$ROOT_DIR/VERSION"
ARTIFACTS_DIR="$ROOT_DIR/artifacts"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ─── Helpers ──────────────────────────────────────────────────────────

log_info()  { echo -e "${CYAN}ℹ${NC}  $*"; }
log_ok()    { echo -e "${GREEN}✓${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
log_err()   { echo -e "${RED}✗${NC}  $*" >&2; }
log_step()  { echo -e "\n${BOLD}── $* ──${NC}"; }

get_version() {
  if [[ ! -f "$VERSION_FILE" ]]; then
    log_err "VERSION file not found at $VERSION_FILE"
    exit 1
  fi
  cat "$VERSION_FILE" | tr -d '[:space:]'
}

check_pnpm() {
  if ! command -v pnpm &>/dev/null; then
    log_err "pnpm is required but not installed."
    log_info "Install with: corepack enable && corepack prepare pnpm@latest --activate"
    exit 1
  fi
}

# ─── Commands ─────────────────────────────────────────────────────────

cmd_version() {
  echo "$(get_version)"
}

cmd_bump() {
  local part="${1:-}"
  local current
  current="$(get_version)"

  IFS='.' read -r major minor patch <<< "$current"

  case "$part" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
    *)
      log_err "Usage: $0 --bump <major|minor|patch>"
      exit 1
      ;;
  esac

  local new_version="${major}.${minor}.${patch}"
  echo "$new_version" > "$VERSION_FILE"

  # Sync version into all package.json files
  sync_versions "$new_version"

  log_ok "Version bumped: ${current} → ${new_version}"
}

sync_versions() {
  local version="$1"
  log_step "Syncing version $version into package.json files"

  # Root package.json (no version field, skip)

  # MCP server
  local mcp_pkg="$ROOT_DIR/packages/mcp-server/package.json"
  if [[ -f "$mcp_pkg" ]]; then
    # Use node for reliable JSON editing
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('$mcp_pkg', 'utf8'));
      pkg.version = '$version';
      fs.writeFileSync('$mcp_pkg', JSON.stringify(pkg, null, 2) + '\n');
    "
    log_ok "  packages/mcp-server/package.json → $version"
  fi

  # Extension
  local ext_pkg="$ROOT_DIR/packages/extension/package.json"
  if [[ -f "$ext_pkg" ]]; then
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('$ext_pkg', 'utf8'));
      pkg.version = '$version';
      fs.writeFileSync('$ext_pkg', JSON.stringify(pkg, null, 2) + '\n');
    "
    log_ok "  packages/extension/package.json → $version"
  fi

  # Shared
  local shared_pkg="$ROOT_DIR/packages/shared/package.json"
  if [[ -f "$shared_pkg" ]]; then
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('$shared_pkg', 'utf8'));
      pkg.version = '$version';
      fs.writeFileSync('$shared_pkg', JSON.stringify(pkg, null, 2) + '\n');
    "
    log_ok "  packages/shared/package.json → $version"
  fi
}

cmd_clean() {
  log_step "Cleaning build artifacts"

  rm -rf "$ROOT_DIR/packages/mcp-server/dist"
  rm -rf "$ROOT_DIR/packages/shared/dist"
  rm -rf "$ROOT_DIR/packages/extension/.output"
  rm -rf "$ROOT_DIR/packages/extension/.wxt"
  rm -rf "$ROOT_DIR/artifacts"
  rm -f "$ROOT_DIR"/*.tsbuildinfo
  rm -f "$ROOT_DIR"/packages/*/*.tsbuildinfo

  log_ok "Clean complete"
}

cmd_build() {
  check_pnpm
  local version
  version="$(get_version)"

  log_step "Building OnBridge v${version}"

  # Sync versions first
  sync_versions "$version"

  # Build in dependency order
  log_info "Building shared..."
  pnpm --filter @onbridge/shared run build
  log_ok "shared built"

  log_info "Building mcp-server..."
  pnpm --filter onbridge run build
  log_ok "mcp-server built"

  log_info "Building extension..."
  pnpm --filter @onbridge/extension run build
  log_ok "extension built"

  log_ok "All packages built successfully (v${version})"
}

cmd_dev() {
  check_pnpm
  log_step "Starting development mode"
  pnpm dev
}

cmd_typecheck() {
  check_pnpm
  log_step "Running TypeScript type checking"
  pnpm typecheck
  log_ok "Type checking passed"
}

cmd_lint() {
  check_pnpm
  log_step "Running ESLint"
  pnpm lint
  log_ok "Lint passed"
}

cmd_package() {
  local version
  version="$(get_version)"

  log_step "Packaging OnBridge v${version}"

  # Ensure build is up to date
  cmd_build

  # Create artifacts directory
  rm -rf "$ARTIFACTS_DIR"
  mkdir -p "$ARTIFACTS_DIR"

  # ── Package MCP Server ──
  log_info "Packaging MCP server..."
  local mcp_artifact="$ARTIFACTS_DIR/onbridge-mcp-server-v${version}"
  mkdir -p "$mcp_artifact"

  cp -r "$ROOT_DIR/packages/mcp-server/dist" "$mcp_artifact/dist"
  cp "$ROOT_DIR/packages/mcp-server/package.json" "$mcp_artifact/package.json"
  cp "$ROOT_DIR/README.md" "$mcp_artifact/README.md" 2>/dev/null || true
  cp "$ROOT_DIR/LICENSE" "$mcp_artifact/LICENSE" 2>/dev/null || true

  # @onbridge/shared is bundled into dist by tsup (noExternal), so it must NOT
  # be copied in as a dependency — it is private, unpublished, and unresolvable.

  # Create tarball
  (cd "$ARTIFACTS_DIR" && tar -czf "onbridge-mcp-server-v${version}.tar.gz" "onbridge-mcp-server-v${version}")
  rm -rf "$mcp_artifact"
  log_ok "MCP server → artifacts/onbridge-mcp-server-v${version}.tar.gz"

  # ── Package Extension ──
  log_info "Packaging Chrome extension..."
  local ext_output="$ROOT_DIR/packages/extension/.output/chrome-mv3"
  if [[ ! -d "$ext_output" ]]; then
    log_err "Extension build output not found at $ext_output"
    log_err "Run './app.sh --build' first"
    exit 1
  fi

  # Zipped from INSIDE chrome-mv3 so manifest.json sits at the archive root.
  # The Chrome Web Store rejects an upload whose manifest is nested in a folder.
  (cd "$ext_output" && zip -qr "$ARTIFACTS_DIR/onbridge-extension-v${version}.zip" . -x '*.DS_Store')
  log_ok "Extension → artifacts/onbridge-extension-v${version}.zip (Web Store ready)"

  # Listing captured first: piping into `grep -q` makes grep exit on the first
  # match, unzip take SIGPIPE, and `set -o pipefail` report the whole pipeline
  # as failed even though the check succeeded.
  local zip_listing
  zip_listing="$(unzip -l "$ARTIFACTS_DIR/onbridge-extension-v${version}.zip")"
  if ! grep -qE ' manifest\.json$' <<<"$zip_listing"; then
    log_err "manifest.json is not at the root of the extension zip — the Web Store will reject it"
    exit 1
  fi

  # ── Summary ──
  log_step "Package Summary"
  echo ""
  ls -lh "$ARTIFACTS_DIR/"
  echo ""
  log_ok "All artifacts ready in ./artifacts/"
}

cmd_help() {
  cat <<EOF

${BOLD}🌉 OnBridge - Build & Release Tooling${NC}

${BOLD}Usage:${NC}
  ./app.sh <command> [options]

${BOLD}Commands:${NC}
  ${CYAN}--build${NC}              Build all packages for production
  ${CYAN}--dev${NC}                Start development mode (all packages in parallel)
  ${CYAN}--clean${NC}              Remove all build artifacts and generated files
  ${CYAN}--typecheck${NC}          Run TypeScript type checking
  ${CYAN}--lint${NC}               Run ESLint across all packages
  ${CYAN}--version${NC}            Print current version from VERSION file
  ${CYAN}--bump <part>${NC}        Bump version (major|minor|patch) and sync to all package.json
  ${CYAN}--package${NC}            Build + package artifacts for distribution
  ${CYAN}--help${NC}               Show this help message

${BOLD}Examples:${NC}
  ./app.sh --build                # Production build
  ./app.sh --bump patch           # 0.1.0 → 0.1.1
  ./app.sh --bump minor           # 0.1.0 → 0.2.0
  ./app.sh --package              # Build + create distributable artifacts

${BOLD}CI/CD:${NC}
  GitHub Actions automatically runs CI on PRs and creates releases on version tags.
  To create a release:
    1. ./app.sh --bump minor
    2. git add -A && git commit -m "chore: bump version to \$(cat VERSION)"
    3. git tag "v\$(cat VERSION)"
    4. git push origin main --tags

EOF
}

# ─── Main ─────────────────────────────────────────────────────────────

main() {
  if [[ $# -eq 0 ]]; then
    cmd_help
    exit 0
  fi

  local command="$1"
  shift

  case "$command" in
    --build)      cmd_build ;;
    --dev)        cmd_dev ;;
    --clean)      cmd_clean ;;
    --typecheck)  cmd_typecheck ;;
    --lint)       cmd_lint ;;
    --version)    cmd_version ;;
    --bump)       cmd_bump "$@" ;;
    --package)    cmd_package ;;
    --help|-h)    cmd_help ;;
    *)
      log_err "Unknown command: $command"
      cmd_help
      exit 1
      ;;
  esac
}

main "$@"
