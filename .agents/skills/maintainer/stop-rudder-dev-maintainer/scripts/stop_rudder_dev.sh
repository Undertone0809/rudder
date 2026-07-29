#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
DRY_RUN=0
FORCE=0
MATCHED_PIDS=()

if [[ -z "$ROOT_DIR" || ! -f "$ROOT_DIR/scripts/dev-shell.mjs" || ! -f "$ROOT_DIR/scripts/dev-runner.mjs" ]]; then
  echo "Unable to resolve the Rudder repository root from $SCRIPT_DIR." >&2
  exit 2
fi

usage() {
  cat <<'EOF'
Usage:
  bash .agents/skills/maintainer/stop-rudder-dev-maintainer/scripts/stop_rudder_dev.sh [--dry-run] [--force]

Behavior:
  - Targets Rudder repo-local dev runtime processes only.
  - Requires an explicit current-checkout dev entrypoint match.
  - Never uses a port listener or a generic `pnpm dev` command as kill authority.
  - Explicitly excludes packaged Rudder.app, `pnpm prod`, and prod-local runtimes.
  - Uses SIGTERM by default.
  - Uses SIGKILL for survivors only when `--force` is provided.
EOF
}

contains_pid() {
  local needle="$1"
  shift || true
  local pid
  for pid in "$@"; do
    if [[ "$pid" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

process_cmd() {
  ps -p "$1" -o command= 2>/dev/null || true
}

process_cwd() {
  lsof -a -d cwd -p "$1" -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

list_processes() {
  ps -Ao pid=,ppid=,command=
}

is_protected_runtime() {
  local cmd="$1"

  [[ "$cmd" == *"/Rudder.app/Contents/"* ]] && return 0
  [[ "$cmd" == *"scripts/prod-desktop.mjs"* ]] && return 0
  [[ "$cmd" == *"RUDDER_LOCAL_ENV=prod_local"* ]] && return 0
  [[ "$cmd" == *"RUDDER_INSTANCE_ID=prod-local"* ]] && return 0
  [[ "$cmd" == *"RUDDER_INSTANCE_ID=prod_local"* ]] && return 0

  return 1
}

matches_target() {
  local pid="$1"
  local cmd="$2"
  local cwd

  [[ -z "$cmd" ]] && return 1
  is_protected_runtime "$cmd" && return 1
  if [[ "$cmd" != *"scripts/dev-shell.mjs"* \
    && "$cmd" != *"scripts/dev-runner.mjs"* \
    && "$cmd" != *"pnpm --filter @rudderhq/desktop dev"* \
    && "$cmd" != *"electron/cli.js dist/main.js"* \
    && ! ( "$cmd" == *"/desktop/dist"* && "$cmd" == *"Rudder-dev"* ) ]]; then
    return 1
  fi

  cwd="$(process_cwd "$pid")"

  if [[ "$cmd" == *"$ROOT_DIR/scripts/dev-shell.mjs"* ]]; then
    return 0
  fi
  if [[ "$cwd" == "$ROOT_DIR" && "$cmd" == *"scripts/dev-shell.mjs"* ]]; then
    return 0
  fi

  if [[ "$cmd" == *"$ROOT_DIR/scripts/dev-runner.mjs"* ]]; then
    return 0
  fi
  if [[ "$cwd" == "$ROOT_DIR" && "$cmd" == *"scripts/dev-runner.mjs"* ]]; then
    return 0
  fi

  if [[ "$cwd" == "$ROOT_DIR" && "$cmd" == *"pnpm --filter @rudderhq/desktop dev"* ]]; then
    return 0
  fi
  if [[ "$cwd" == "$ROOT_DIR/desktop" && "$cmd" == *"electron/cli.js dist/main.js"* ]]; then
    return 0
  fi
  if [[ "$cwd" == "$ROOT_DIR/desktop" && "$cmd" == *"$ROOT_DIR/desktop/dist"* && "$cmd" == *"Rudder-dev"* ]]; then
    return 0
  fi

  return 1
}

add_match() {
  local pid="$1"
  if ! contains_pid "$pid" "${MATCHED_PIDS[@]:-}"; then
    MATCHED_PIDS+=("$pid")
  fi
}

scan_matches() {
  local pid
  local ppid
  local cmd

  MATCHED_PIDS=()
  while read -r pid ppid cmd; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    if matches_target "$pid" "$cmd"; then
      add_match "$pid"
    fi
  done < <(list_processes)
}

main() {
  local deadline
  local pid
  local current_cmd
  local survivors=()
  local final_survivors=()

  while (($# > 0)); do
    case "$1" in
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --force)
        FORCE=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown argument: $1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done

  scan_matches

  if ((${#MATCHED_PIDS[@]} == 0)); then
    echo "No matching Rudder dev processes found."
    exit 0
  fi

  echo "Matched Rudder dev entrypoints:"
  for pid in "${MATCHED_PIDS[@]}"; do
    printf '  %s %s\n' "$pid" "$(process_cmd "$pid")"
  done

  if ((DRY_RUN)); then
    echo "Dry run only. No signals sent."
    exit 0
  fi

  for pid in "${MATCHED_PIDS[@]}"; do
    current_cmd="$(process_cmd "$pid")"
    if matches_target "$pid" "$current_cmd"; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done

  deadline=$((SECONDS + 10))
  while ((SECONDS < deadline)); do
    survivors=()
    for pid in "${MATCHED_PIDS[@]}"; do
      current_cmd="$(process_cmd "$pid")"
      if [[ -n "$current_cmd" ]] && matches_target "$pid" "$current_cmd" && kill -0 "$pid" 2>/dev/null; then
        survivors+=("$pid")
      fi
    done

    if ((${#survivors[@]} == 0)); then
      echo "Stopped all matched Rudder dev entrypoints."
      exit 0
    fi

    sleep 1
  done

  echo "Dev entrypoints still running after SIGTERM:"
  for pid in "${survivors[@]}"; do
    printf '  %s %s\n' "$pid" "$(process_cmd "$pid")"
  done

  if ((FORCE)); then
    for pid in "${survivors[@]}"; do
      current_cmd="$(process_cmd "$pid")"
      if matches_target "$pid" "$current_cmd"; then
        kill -KILL "$pid" 2>/dev/null || true
      fi
    done
    sleep 1

    final_survivors=()
    for pid in "${survivors[@]}"; do
      current_cmd="$(process_cmd "$pid")"
      if [[ -n "$current_cmd" ]] && matches_target "$pid" "$current_cmd" && kill -0 "$pid" 2>/dev/null; then
        final_survivors+=("$pid")
      fi
    done

    if ((${#final_survivors[@]} == 0)); then
      echo "Force-stopped remaining Rudder dev entrypoints."
      exit 0
    fi

    echo "Some dev entrypoints survived SIGKILL:"
    for pid in "${final_survivors[@]}"; do
      printf '  %s %s\n' "$pid" "$(process_cmd "$pid")"
    done
    exit 1
  fi

  echo "Run again with --force to hard-stop only these verified dev entrypoints."
  exit 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
