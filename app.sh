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
#   ./app.sh --release [part] Bump, verify, package, tag, push, publish to the Web Store
#   ./app.sh --store <cmd>    Web Store: auth | status | upload | publish | release
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
  pnpm --filter @onllm-dev/onbridge-mcp run build
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

  # Replace only what this command produces. artifacts/store/ holds the Web
  # Store screenshots from scripts/store-screenshots.mjs and must survive.
  mkdir -p "$ARTIFACTS_DIR"
  rm -f "$ARTIFACTS_DIR"/*.zip "$ARTIFACTS_DIR"/*.tar.gz

  # ── Package MCP Server ──
  log_info "Packaging MCP server..."
  local mcp_artifact="$ARTIFACTS_DIR/onbridge-mcp-server-v${version}"
  mkdir -p "$mcp_artifact"

  cp -r "$ROOT_DIR/packages/mcp-server/dist" "$mcp_artifact/dist"

  # devDependencies are stripped from the shipped manifest. They reference
  # @onbridge/shared as "workspace:*", and `npm install` inside the extracted
  # tarball — which install.sh runs — fails with EUNSUPPORTEDPROTOCOL on that,
  # even under --production. Nothing in devDependencies is needed at runtime.
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$ROOT_DIR/packages/mcp-server/package.json', 'utf8'));
    delete pkg.devDependencies;
    delete pkg.scripts;
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      if (String(range).startsWith('workspace:')) {
        throw new Error('runtime dependency ' + name + ' uses the workspace protocol and will not install');
      }
    }
    fs.writeFileSync('$mcp_artifact/package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
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
  # It also rejects a manifest carrying the `key` field, which the build keeps
  # so unpacked installs share the published id; strip it from a staging copy.
  local ext_stage
  ext_stage="$(mktemp -d)"
  cp -R "$ext_output"/. "$ext_stage"/
  node -e "
    const fs = require('fs');
    const m = JSON.parse(fs.readFileSync('$ext_stage/manifest.json', 'utf8'));
    delete m.key;
    fs.writeFileSync('$ext_stage/manifest.json', JSON.stringify(m));
  "
  (cd "$ext_stage" && zip -qr "$ARTIFACTS_DIR/onbridge-extension-v${version}.zip" . -x '*.DS_Store')
  rm -rf "$ext_stage"
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

CWS_ENV_FILE="${ONBRIDGE_CWS_ENV:-$HOME/.config/onbridge/chrome-web-store.env}"

# Chrome Web Store: status, upload, publish, release. Credentials live outside
# the repo in $CWS_ENV_FILE, written once by chrome-web-store.auth.mjs.
cmd_store() {
  local sub="${1:-status}"
  shift || true
  case "$sub" in
    auth)
      node "$ROOT_DIR/scripts/release/chrome-web-store.auth.mjs" "$@"
      ;;
    status|upload|publish|release)
      node "$ROOT_DIR/scripts/release/chrome-web-store.publish.mjs" "$sub" "$@"
      ;;
    *)
      log_err "Usage: $0 --store <auth|status|upload|publish|release> [--zip <path>] [--percent <1-100>]"
      exit 1
      ;;
  esac
}

# Cuts a release from this machine: bump, verify, package, commit, tag, push,
# then upload and publish to the Chrome Web Store. The GitHub release itself is
# created by .github/workflows/release.yml when the tag lands; that workflow
# holds no store credentials and never talks to the store.
cmd_release() {
  local part="patch"
  local run_browser_tests=1
  local do_store=1
  while [[ $# -gt 0 ]]; do
    case "$1" in
      major|minor|patch) part="$1" ;;
      --skip-browser-tests) run_browser_tests=0 ;;
      --skip-store) do_store=0 ;;
      *)
        log_err "Usage: $0 --release [major|minor|patch] [--skip-browser-tests] [--skip-store]"
        exit 1
        ;;
    esac
    shift
  done

  check_pnpm
  command -v git >/dev/null || { log_err "git is required"; exit 1; }

  log_step "Preflight"
  if [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
    log_err "Working tree is not clean. Commit or stash first."
    git -C "$ROOT_DIR" status --short
    exit 1
  fi
  local branch
  branch="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" != "main" ]]; then
    log_err "Releases are cut from main (currently on $branch)"
    exit 1
  fi
  git -C "$ROOT_DIR" fetch origin main --quiet
  if [[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" != "$(git -C "$ROOT_DIR" rev-parse origin/main)" ]]; then
    log_err "Local main differs from origin/main. Pull or push first."
    exit 1
  fi
  if [[ "$do_store" -eq 1 && ! -f "$CWS_ENV_FILE" ]]; then
    log_warn "No store credentials at $CWS_ENV_FILE."
    log_warn "The tag will still be pushed; upload the zip by hand, or run: ./app.sh --store auth"
    do_store=0
  fi
  log_ok "clean tree on main, in sync with origin"

  cmd_bump "$part"
  local version
  version="$(get_version)"

  log_step "Verifying v${version}"
  pnpm typecheck
  pnpm test
  if [[ "$run_browser_tests" -eq 1 ]]; then
    pnpm test:browser
  else
    log_warn "browser suite skipped"
  fi

  cmd_package

  log_step "Committing and tagging v${version}"
  git -C "$ROOT_DIR" add VERSION packages/mcp-server/package.json packages/extension/package.json packages/shared/package.json
  git -C "$ROOT_DIR" commit -q -m "chore(release): v${version}"
  git -C "$ROOT_DIR" tag "v${version}"
  git -C "$ROOT_DIR" push origin main
  git -C "$ROOT_DIR" push origin "v${version}"
  log_ok "pushed; GitHub Actions is building the GitHub release for v${version}"

  if [[ "$do_store" -eq 1 ]]; then
    log_step "Chrome Web Store"
    cmd_store release --zip "$ARTIFACTS_DIR/onbridge-extension-v${version}.zip"
  fi

  log_ok "Release v${version} done"
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
  ${CYAN}--release [part]${NC}     Bump, verify, package, tag, push, publish to the Web Store
  ${CYAN}--store <cmd>${NC}        Web Store: auth | status | upload | publish | release
  ${CYAN}--help${NC}               Show this help message

${BOLD}Examples:${NC}
  ./app.sh --build                # Production build
  ./app.sh --bump patch           # 0.1.0 → 0.1.1
  ./app.sh --bump minor           # 0.1.0 → 0.2.0
  ./app.sh --package              # Build + create distributable artifacts
  ./app.sh --release              # Patch release, end to end, from this machine
  ./app.sh --release minor --skip-browser-tests
  ./app.sh --store status         # What the store currently has

${BOLD}Releasing:${NC}
  Everything runs from this machine. One-time setup: ./app.sh --store auth
  stores Web Store credentials in ~/.config/onbridge/chrome-web-store.env
  (never in the repo). GitHub Actions only builds the GitHub release from the
  pushed tag; it holds no store credentials. See docs/CHROME_WEB_STORE.md.

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
    --release)    cmd_release "$@" ;;
    --store)      cmd_store "$@" ;;
    --help|-h)    cmd_help ;;
    *)
      log_err "Unknown command: $command"
      cmd_help
      exit 1
      ;;
  esac
}

main "$@"
