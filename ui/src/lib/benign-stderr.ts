const CODEX_MODELS_REFRESH_TIMEOUT_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+(?:codex_core::models_manager::manager|codex_models_manager::manager):\s+failed to refresh available models:\s+timeout waiting for child process to exit$/i;
const CODEX_MEMORIES_PHASE2_NO_CHANGES_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_memories_write::phase2:\s+Phase 2 no changes$/i;

export function isBenignStderrLine(line: string): boolean {
  const trimmed = line.trim();
  return CODEX_MODELS_REFRESH_TIMEOUT_RE.test(trimmed) || CODEX_MEMORIES_PHASE2_NO_CHANGES_RE.test(trimmed);
}

export function stripBenignStderr(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !isBenignStderrLine(line))
    .join("\n")
    .trim();
}
