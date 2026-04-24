#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
DRY_RUN=0
FORCE=0
MATCHED_PIDS=()
ALL_PIDS=()

usage() {
  cat <<'EOF'
Usage:
  bash .agents/skills/stop-rudder-dev-maintainer/scripts/stop_rudder_dev.sh [--dry-run] [--force]

Behavior:
  - Targets Rudder repo-local dev runtime processes only.
  - Stops `pnpm dev` / `scripts/dev-shell.mjs` first when present.
  - Falls back to repo-local dev runner / desktop Electron processes when the parent is already gone.
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

pid_in_repo() {
  local pid="$1"
  local cmd="${2:-}"
  local cwd

  if [[ -z "$cmd" ]]; then
    cmd="$(process_cmd "$pid")"
  fi

  if [[ -n "$cmd" && "$cmd" == *"$ROOT_DIR"* ]]; then
    return 0
  fi

  cwd="$(process_cwd "$pid")"
  if [[ "$cwd" == "$ROOT_DIR" || "$cwd" == "$ROOT_DIR/"* ]]; then
    return 0
  fi

  return 1
}

matches_target() {
  local cmd="$1"

  [[ "$cmd" == *"scripts/dev-shell.mjs"* ]] && return 0
  [[ "$cmd" == *"pnpm dev"* ]] && return 0
  [[ "$cmd" == *"pnpm --filter @rudderhq/desktop dev"* ]] && return 0
  [[ "$cmd" == *"scripts/dev-runner.mjs"* ]] && return 0
  [[ "$cmd" == *"electron/cli.js dist/main.js"* ]] && return 0
  [[ "$cmd" == *"/desktop/dist"* && "$cmd" == *"Rudder-dev"* ]] && return 0

  return 1
}

add_match() {
  local pid="$1"
  if ! contains_pid "$pid" "${MATCHED_PIDS[@]:-}"; then
    MATCHED_PIDS+=("$pid")
  fi
}

add_pid_recursive() {
  local pid="$1"
  local child

  if ! kill -0 "$pid" 2>/dev/null; then
    return
  fi

  if ! contains_pid "$pid" "${ALL_PIDS[@]:-}"; then
    ALL_PIDS+=("$pid")
  fi

  while IFS= read -r child; do
    [[ -z "$child" ]] && continue
    add_pid_recursive "$child"
  done < <(pgrep -P "$pid" || true)
}

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

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  pid="${line%% *}"
  cmd="${line#* }"

  if ! matches_target "$cmd"; then
    continue
  fi

  if pid_in_repo "$pid" "$cmd"; then
    add_match "$pid"
  fi
done < <(ps -Ao pid=,command=)

if ((${#MATCHED_PIDS[@]} == 0)); then
  echo "No matching Rudder dev processes found."
  exit 0
fi

for pid in "${MATCHED_PIDS[@]}"; do
  add_pid_recursive "$pid"
done

echo "Matched Rudder dev processes:"
for pid in "${ALL_PIDS[@]}"; do
  printf '  %s %s\n' "$pid" "$(process_cmd "$pid")"
done

if ((DRY_RUN)); then
  echo "Dry run only. No signals sent."
  exit 0
fi

kill -TERM "${ALL_PIDS[@]}" 2>/dev/null || true

deadline=$((SECONDS + 10))
while ((SECONDS < deadline)); do
  survivors=()
  for pid in "${ALL_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      survivors+=("$pid")
    fi
  done

  if ((${#survivors[@]} == 0)); then
    echo "Stopped all matched Rudder dev processes."
    exit 0
  fi

  sleep 1
done

echo "Processes still running after SIGTERM:"
for pid in "${survivors[@]}"; do
  printf '  %s %s\n' "$pid" "$(process_cmd "$pid")"
done

if ((FORCE)); then
  kill -KILL "${survivors[@]}" 2>/dev/null || true
  sleep 1

  final_survivors=()
  for pid in "${survivors[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      final_survivors+=("$pid")
    fi
  done

  if ((${#final_survivors[@]} == 0)); then
    echo "Force-stopped remaining Rudder dev processes."
    exit 0
  fi

  echo "Some processes survived SIGKILL:"
  for pid in "${final_survivors[@]}"; do
    printf '  %s %s\n' "$pid" "$(process_cmd "$pid")"
  done
  exit 1
fi

echo "Run again with --force to hard-stop the survivors."
exit 1
