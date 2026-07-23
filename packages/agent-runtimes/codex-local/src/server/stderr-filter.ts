import { isCodexClosedStdinToolSessionError } from "../shared/tool-errors.js";

const CODEX_BENIGN_STDERR_RES = [
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::rollout::list:\s+state db missing rollout path for thread\s+[a-z0-9-]+$/i,
  /^Error:\s+thread\/resume:\s+thread\/resume failed:\s+no rollout found for thread id\s+[a-z0-9-]+$/i,
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+WARN\s+codex_core::shell_snapshot:\s+Failed to delete shell snapshot at\s+".+?\.tmp-\d+":\s+Os\s+\{\s+code:\s*2,\s+kind:\s*NotFound,\s+message:\s*"No such file or directory"\s+\}$/i,
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+WARN\s+codex_protocol::openai_models:\s+Model personality requested but model_messages is missing, falling back to base instructions\.\s+model=\S+\s+personality=\S+$/i,
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::models_manager::manager:\s+failed to refresh available models:\s+timeout waiting for child process to exit$/i,
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+WARN\s+codex_rmcp_client::stdio_server_launcher:\s+Failed to kill MCP process group for server (?:rudder-tools|rudder-browser):\s+No such process\s+\(os error 3\)$/i,
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_memories_write::phase2:\s+Phase 2 no changes$/i,
] as const;
const CODEX_ANALYTICS_FORBIDDEN_HTML_START_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+WARN\s+codex_analytics::analytics_client:\s+events failed with status 403 Forbidden:\s+<html>$/i;
const APP_SERVER_EVENT_STREAM_LAG_RE = /(?:^|\s)in-process app-server event stream lagged; dropped\s+\d+\s+events\s*$/i;

export function createCodexStderrLineFilter() {
  let suppressingAnalyticsHtml = false;

  return (line: string): boolean => {
    const trimmed = line.trim();
    if (suppressingAnalyticsHtml) {
      if (/^<\/html>$/i.test(trimmed)) suppressingAnalyticsHtml = false;
      return true;
    }
    if (CODEX_ANALYTICS_FORBIDDEN_HTML_START_RE.test(trimmed)) {
      suppressingAnalyticsHtml = true;
      return true;
    }
    return isCodexClosedStdinToolSessionError(trimmed)
      || APP_SERVER_EVENT_STREAM_LAG_RE.test(trimmed)
      || CODEX_BENIGN_STDERR_RES.some((pattern) => pattern.test(trimmed));
  };
}

export function stripCodexBenignStderr(text: string): string {
  const shouldSuppress = createCodexStderrLineFilter();
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trim() || !shouldSuppress(line))
    .join("\n");
}

export function splitCompleteLines(text: string): { lines: string[]; remainder: string } {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    lines.push(text.slice(start, index + 1));
    start = index + 1;
  }
  return { lines, remainder: text.slice(start) };
}
