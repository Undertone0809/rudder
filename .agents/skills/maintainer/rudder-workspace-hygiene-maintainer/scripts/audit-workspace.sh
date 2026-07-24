#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' \
    "Usage: audit-workspace.sh [--repo PATH] [--sizes]" \
    "Read-only audit of Rudder worktrees, generated directories, and scoped processes."
}

repo_path="."
include_sizes="false"

while (($# > 0)); do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      repo_path="$2"
      shift 2
      ;;
    --sizes) include_sizes="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

repo_root="$(git -C "$repo_path" rev-parse --show-toplevel)"

printf 'repo_root\t%s\n' "$repo_root"
df -h "$repo_root" | sed -n '1,2p'
printf '\ncurrent_status\n'
git -C "$repo_root" status --short --branch
printf '\nregistered_worktrees\n'
git -C "$repo_root" worktree list --porcelain

worktree_roots=()
while IFS= read -r worktree_root; do
  worktree_roots+=("$worktree_root")
done < <(git -C "$repo_root" worktree list --porcelain | sed -n 's/^worktree //p')

if [[ "$include_sizes" == "true" ]]; then
  printf '\nworktree_sizes\n'
  for worktree_root in "${worktree_roots[@]}"; do
    size="$(du -sh "$worktree_root" 2>/dev/null | awk '{print $1}' || true)"
    dirty_count="$(git -C "$worktree_root" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    printf '%s\t%s\tdirty=%s\n' "${size:-unknown}" "$worktree_root" "$dirty_count"
  done
fi

printf '\nscoped_processes_redacted\n'
printf 'pid\tppid\tetime\trss_kib\texecutable\towner\n'
while IFS= read -r process_line; do
  matched="false"
  for worktree_root in "${worktree_roots[@]}"; do
    if [[ "$process_line" == *"$worktree_root"* ]]; then
      matched="true"
      break
    fi
  done
  [[ "$process_line" == *"/mcp-chrome-bridge/"* ]] && matched="true"
  [[ "$matched" == "true" ]] || continue
  read -r pid ppid etime rss executable owner _ <<<"$process_line"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$pid" "$ppid" "$etime" "$rss" "$executable" "$owner"
done < <(ps -axo pid=,ppid=,etime=,rss=,comm=,user=,command=)

printf '\ngenerated_directories\n'
for relative_path in \
  node_modules ui/dist server/dist desktop/dist desktop/release \
  test-results playwright-report; do
  candidate="$repo_root/$relative_path"
  if [[ -e "$candidate" ]]; then
    size="$(du -sh "$candidate" 2>/dev/null | awk '{print $1}' || true)"
    printf '%s\t%s\n' "${size:-unknown}" "$candidate"
  fi
done
