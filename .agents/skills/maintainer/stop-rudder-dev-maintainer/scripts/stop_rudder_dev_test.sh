#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"

# shellcheck source=stop_rudder_dev.sh
source "$SCRIPT_DIR/stop_rudder_dev.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_match() {
  local label="$1"
  local pid="$2"
  local cmd="$3"
  if ! matches_target "$pid" "$cmd"; then
    fail "$label should match"
  fi
}

assert_no_match() {
  local label="$1"
  local pid="$2"
  local cmd="$3"
  if matches_target "$pid" "$cmd"; then
    fail "$label must not match"
  fi
}

[[ "$ROOT_DIR" == "$REPO_ROOT" ]] || fail "repository root resolved to $ROOT_DIR"

FAKE_CWD=""
process_cwd() {
  printf '%s\n' "$FAKE_CWD"
}

FAKE_CWD="$REPO_ROOT"
assert_match "relative dev shell" 101 "node scripts/dev-shell.mjs dev"
assert_match "absolute dev runner" 102 "node $REPO_ROOT/scripts/dev-runner.mjs dev"
assert_match "desktop dev wrapper" 103 "pnpm --filter @rudderhq/desktop dev"

FAKE_CWD="$REPO_ROOT/desktop"
assert_match "desktop dev Electron" 104 "$REPO_ROOT/node_modules/electron/cli.js dist/main.js"

FAKE_CWD="$REPO_ROOT"
assert_no_match "generic pnpm dev" 201 "pnpm dev"
assert_no_match "production launcher" 202 "node scripts/prod-desktop.mjs"
assert_no_match "packaged app" 203 "/Users/test/Applications/Rudder.app/Contents/MacOS/Rudder scripts/dev-shell.mjs"
assert_no_match "prod-local environment" 204 "RUDDER_LOCAL_ENV=prod_local node $REPO_ROOT/scripts/dev-runner.mjs"

FAKE_CWD="/Users/test/another-repo"
assert_no_match "other checkout dev shell" 205 "node scripts/dev-shell.mjs dev"
assert_no_match "packaged Electron" 206 "/Users/test/Applications/Rudder.app/Contents/MacOS/Rudder"

list_processes() {
  cat <<EOF
    301       1 node scripts/dev-shell.mjs dev
    302       1 pnpm dev
    303       1 /Users/test/Applications/Rudder.app/Contents/MacOS/Rudder
EOF
}

process_cwd() {
  case "$1" in
    301|302) printf '%s\n' "$REPO_ROOT" ;;
    303) printf '%s\n' "/Users/test/Applications" ;;
    *) return 1 ;;
  esac
}

scan_matches
[[ "${#MATCHED_PIDS[@]}" -eq 1 ]] || fail "process-table parsing matched ${#MATCHED_PIDS[@]} processes"
[[ "${MATCHED_PIDS[0]}" == "301" ]] || fail "process-table parsing matched PID ${MATCHED_PIDS[0]}"

node -e 'setInterval(() => {}, 1000)' "$REPO_ROOT/scripts/dev-shell.mjs" &
DUMMY_PID=$!
disown "$DUMMY_PID" 2>/dev/null || true
cleanup() {
  kill "$DUMMY_PID" 2>/dev/null || true
}
trap cleanup EXIT
sleep 0.2

STOP_OUTPUT="$(bash "$SCRIPT_DIR/stop_rudder_dev.sh")" 2>/dev/null
[[ "$STOP_OUTPUT" == *"$DUMMY_PID"* ]] || fail "integration stop did not report dummy PID $DUMMY_PID"
if kill -0 "$DUMMY_PID" 2>/dev/null; then
  fail "integration stop left dummy PID $DUMMY_PID running"
fi
trap - EXIT

echo "stop_rudder_dev safety tests passed."
