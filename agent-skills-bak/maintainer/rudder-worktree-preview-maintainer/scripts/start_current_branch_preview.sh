#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
TMP_BASE="${TMPDIR:-/tmp}/rudder-worktree-preview"
BASE_PORT="${RUDDER_PREVIEW_BASE_PORT:-3310}"
BASE_PG_PORT="${RUDDER_PREVIEW_BASE_PG_PORT:-55310}"
PORT=""
PG_PORT=""
INSTANCE_ID=""
HOME_DIR=""
DATABASE_URL_VALUE="${RUDDER_PREVIEW_DATABASE_URL:-}"
MANAGER="${RUDDER_PREVIEW_MANAGER:-auto}"
ACTION="start"
REPLACE=0
WAIT_SECONDS="${RUDDER_PREVIEW_WAIT_SECONDS:-90}"

usage() {
  cat <<'EOF'
Usage:
  bash .agents/skills/maintainer/rudder-worktree-preview-maintainer/scripts/start_current_branch_preview.sh [options]

Options:
  --replace                 Restart the managed preview for this instance if it exists.
  --stop                    Stop the managed preview for this instance.
  --port <port>             App port to use. Defaults to the first free port from 3310.
  --pg-port <port>          Embedded PostgreSQL port. Defaults to first free port from 55310.
  --instance-id <id>        Rudder instance id. Defaults to a slug from the current branch.
  --home <path>             RUDDER_HOME. Defaults to /tmp/rudder-worktree-preview/<instance-id>/home.
  --database-url <url>      Use an isolated external PostgreSQL database instead of embedded PostgreSQL.
  --manager <kind>          auto, tmux, launchctl, or foreground. Defaults to auto.
  -h, --help                Show this help.

The script starts the current Rudder worktree with @rudderhq/server dev and
Vite dev middleware, waits for /api/health, then prints the preview URL and
cleanup command.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

shell_quote() {
  printf "%q" "$1"
}

slugify() {
  local raw="$1"
  local slug
  slug="$(printf "%s" "$raw" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//; s/-{2,}/-/g')"
  if [[ -z "$slug" ]]; then
    slug="worktree"
  fi
  printf "%.54s" "$slug"
}

port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

find_free_port() {
  local candidate="$1"
  while port_in_use "$candidate"; do
    candidate=$((candidate + 1))
  done
  printf "%s" "$candidate"
}

health_url() {
  printf "http://127.0.0.1:%s/api/health" "$PORT"
}

preview_url() {
  printf "http://127.0.0.1:%s" "$PORT"
}

tmux_session_name() {
  printf "rudder-preview-%s" "$INSTANCE_ID"
}

launchctl_label() {
  printf "com.rudder.preview.%s" "$INSTANCE_ID"
}

branch_name() {
  local branch
  branch="$(git -C "$ROOT_DIR" branch --show-current 2>/dev/null || true)"
  if [[ -n "$branch" ]]; then
    printf "%s" "$branch"
    return
  fi
  git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || printf "worktree"
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --replace)
        REPLACE=1
        shift
        ;;
      --stop)
        ACTION="stop"
        shift
        ;;
      --port)
        PORT="${2:-}"
        [[ -n "$PORT" ]] || die "--port requires a value"
        shift 2
        ;;
      --pg-port)
        PG_PORT="${2:-}"
        [[ -n "$PG_PORT" ]] || die "--pg-port requires a value"
        shift 2
        ;;
      --instance-id)
        INSTANCE_ID="${2:-}"
        [[ -n "$INSTANCE_ID" ]] || die "--instance-id requires a value"
        shift 2
        ;;
      --home)
        HOME_DIR="${2:-}"
        [[ -n "$HOME_DIR" ]] || die "--home requires a value"
        shift 2
        ;;
      --database-url)
        DATABASE_URL_VALUE="${2:-}"
        [[ -n "$DATABASE_URL_VALUE" ]] || die "--database-url requires a value"
        shift 2
        ;;
      --manager)
        MANAGER="${2:-}"
        [[ -n "$MANAGER" ]] || die "--manager requires a value"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done
}

validate_manager() {
  case "$MANAGER" in
    auto|tmux|launchctl|foreground) ;;
    *) die "--manager must be auto, tmux, launchctl, or foreground" ;;
  esac
}

resolve_defaults() {
  local branch slug
  branch="$(branch_name)"
  slug="$(slugify "$branch")"

  if [[ -z "$INSTANCE_ID" ]]; then
    INSTANCE_ID="$slug"
  fi

  if [[ ! "$INSTANCE_ID" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    die "invalid instance id '$INSTANCE_ID'; use only letters, numbers, underscore, and hyphen"
  fi

  if [[ -z "$PORT" ]]; then
    PORT="$(find_free_port "$BASE_PORT")"
  fi

  if [[ -z "$PG_PORT" ]]; then
    PG_PORT="$(find_free_port "$BASE_PG_PORT")"
  fi

  if [[ -z "$HOME_DIR" ]]; then
    HOME_DIR="$TMP_BASE/$INSTANCE_ID/home"
  fi
}

choose_manager() {
  if [[ "$MANAGER" != "auto" ]]; then
    printf "%s" "$MANAGER"
    return
  fi

  if command -v tmux >/dev/null 2>&1; then
    printf "tmux"
    return
  fi

  if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
    printf "launchctl"
    return
  fi

  printf "foreground"
}

stop_preview() {
  local session label stopped
  session="$(tmux_session_name)"
  label="$(launchctl_label)"
  stopped=0

  if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$session" 2>/dev/null; then
    tmux kill-session -t "$session"
    echo "Stopped tmux session: $session"
    stopped=1
  fi

  if command -v launchctl >/dev/null 2>&1 && launchctl list | grep -Fq "$label"; then
    launchctl remove "$label"
    echo "Stopped launchctl job: $label"
    stopped=1
  fi

  if ((stopped == 0)); then
    echo "No managed preview found for instance: $INSTANCE_ID"
  fi
}

build_command() {
  local config_path pnpm_bin cmd
  config_path="$HOME_DIR/instances/$INSTANCE_ID/config.json"
  pnpm_bin="$(command -v pnpm || true)"
  [[ -n "$pnpm_bin" ]] || die "pnpm not found on PATH"

  mkdir -p "$(dirname "$config_path")" "$TMP_BASE/$INSTANCE_ID"

  cmd="cd $(shell_quote "$ROOT_DIR") && unset DATABASE_URL && env"
  cmd+=" RUDDER_HOME=$(shell_quote "$HOME_DIR")"
  cmd+=" RUDDER_CONFIG=$(shell_quote "$config_path")"
  cmd+=" RUDDER_INSTANCE_ID=$(shell_quote "$INSTANCE_ID")"
  cmd+=" RUDDER_WORKTREE_NAME=$(shell_quote "$(branch_name)")"
  cmd+=" RUDDER_LOCAL_ENV=dev"
  cmd+=" PORT=$(shell_quote "$PORT")"
  cmd+=" RUDDER_UI_DEV_MIDDLEWARE=true"
  cmd+=" RUDDER_MIGRATION_PROMPT=never"
  cmd+=" RUDDER_MIGRATION_AUTO_APPLY=true"

  if [[ -n "$DATABASE_URL_VALUE" ]]; then
    cmd+=" DATABASE_URL=$(shell_quote "$DATABASE_URL_VALUE")"
  else
    cmd+=" RUDDER_EMBEDDED_POSTGRES_PORT=$(shell_quote "$PG_PORT")"
  fi

  cmd+=" $(shell_quote "$pnpm_bin") --filter @rudderhq/server dev"
  printf "%s" "$cmd"
}

wait_for_health() {
  local deadline body
  deadline=$((SECONDS + WAIT_SECONDS))
  while ((SECONDS < deadline)); do
    if body="$(curl -fsS --max-time 2 "$(health_url)" 2>/dev/null)"; then
      if printf "%s" "$body" | grep -Fq "\"instanceId\":\"$INSTANCE_ID\""; then
        echo "$body"
        return 0
      fi
      echo "Health endpoint responded, but instance id did not match $INSTANCE_ID:" >&2
      echo "$body" >&2
      return 1
    fi
    sleep 1
  done
  return 1
}

start_with_tmux() {
  local session log_file cmd
  session="$(tmux_session_name)"
  log_file="$TMP_BASE/$INSTANCE_ID/tmux.log"
  cmd="$(build_command)"
  cmd="$cmd 2>&1 | tee -a $(shell_quote "$log_file")"

  if tmux has-session -t "$session" 2>/dev/null; then
    if ((REPLACE)); then
      tmux kill-session -t "$session"
    else
      die "tmux session already exists: $session (rerun with --replace)"
    fi
  fi

  tmux new-session -d -s "$session" -c "$ROOT_DIR" "$cmd"
  echo "$log_file"
}

start_with_launchctl() {
  local label out_log err_log cmd
  label="$(launchctl_label)"
  out_log="$TMP_BASE/$INSTANCE_ID/launchctl.out.log"
  err_log="$TMP_BASE/$INSTANCE_ID/launchctl.err.log"
  cmd="$(build_command)"

  if launchctl list | grep -Fq "$label"; then
    if ((REPLACE)); then
      launchctl remove "$label"
    else
      die "launchctl job already exists: $label (rerun with --replace)"
    fi
  fi

  launchctl submit -l "$label" -o "$out_log" -e "$err_log" -- /bin/bash -lc "$cmd"
  echo "$out_log"
}

start_foreground() {
  local cmd
  cmd="$(build_command)"
  echo "Starting in foreground. Stop with Ctrl-C." >&2
  /bin/bash -lc "$cmd"
}

print_failure_help() {
  local manager_kind log_path session
  manager_kind="$1"
  log_path="$2"
  session="$(tmux_session_name)"

  echo "Preview did not become ready on $(health_url)." >&2
  if [[ "$manager_kind" == "tmux" ]]; then
    echo "Recent tmux output:" >&2
    tmux capture-pane -pt "$session" -S -120 2>/dev/null >&2 || true
  fi
  if [[ -n "$log_path" && -f "$log_path" ]]; then
    echo "Recent log output from $log_path:" >&2
    tail -120 "$log_path" >&2 || true
  fi
}

print_success() {
  local manager_kind log_path stop_cmd
  manager_kind="$1"
  log_path="$2"
  stop_cmd="bash .agents/skills/maintainer/rudder-worktree-preview-maintainer/scripts/start_current_branch_preview.sh --instance-id $INSTANCE_ID --stop"

  echo "Rudder preview is running."
  echo "URL: $(preview_url)"
  echo "Health: $(health_url)"
  echo "Instance: $INSTANCE_ID"
  echo "RUDDER_HOME: $HOME_DIR"
  if [[ -n "$DATABASE_URL_VALUE" ]]; then
    echo "Database: external DATABASE_URL"
  else
    echo "Database: embedded PostgreSQL on port $PG_PORT"
  fi

  case "$manager_kind" in
    tmux)
      echo "Logs: tmux attach -t $(tmux_session_name)"
      echo "Log file: $log_path"
      ;;
    launchctl)
      echo "Logs: $log_path"
      ;;
  esac

  echo "Stop: $stop_cmd"
}

main() {
  local manager_kind log_path
  parse_args "$@"
  validate_manager
  resolve_defaults

  if [[ "$ACTION" == "stop" ]]; then
    stop_preview
    exit 0
  fi

  manager_kind="$(choose_manager)"
  log_path=""

  case "$manager_kind" in
    tmux)
      log_path="$(start_with_tmux)"
      ;;
    launchctl)
      log_path="$(start_with_launchctl)"
      ;;
    foreground)
      start_foreground
      exit $?
      ;;
  esac

  if wait_for_health >/dev/null; then
    print_success "$manager_kind" "$log_path"
    exit 0
  fi

  print_failure_help "$manager_kind" "$log_path"
  exit 1
}

main "$@"
