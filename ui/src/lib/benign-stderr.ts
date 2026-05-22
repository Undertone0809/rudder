const CODEX_MODELS_REFRESH_TIMEOUT_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+(?:codex_core::models_manager::manager|codex_models_manager::manager):\s+failed to refresh available models:\s+timeout waiting for child process to exit$/i;

export function isBenignStderrLine(line: string): boolean {
  return CODEX_MODELS_REFRESH_TIMEOUT_RE.test(line.trim());
}

export function stripBenignStderr(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !isBenignStderrLine(line))
    .join("\n")
    .trim();
}
