const CLOSED_STDIN_TOOL_SESSION_RE = /\bwrite_stdin\b[\s\S]*\bstdin is closed\b/i;
const CLOSED_STDIN_TOOL_SESSION_HINT_RE = /\brerun exec_command with tty=true to keep stdin open\b/i;

export function isCodexClosedStdinToolSessionError(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.replace(/\s+/g, " ").trim();
  return CLOSED_STDIN_TOOL_SESSION_RE.test(normalized) || CLOSED_STDIN_TOOL_SESSION_HINT_RE.test(normalized);
}

export const CODEX_CLOSED_STDIN_TOOL_SESSION_MESSAGE =
  "Codex tool stdin was already closed; Rudder suppressed this tool-session lifecycle warning.";
