const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function appendBoundedDesktopUpdateOutput(current: string, chunk: string, maxLength = 4000): string {
  const next = `${current}${chunk}`;
  if (next.length <= maxLength) return next;
  return next.slice(next.length - maxLength);
}

export function summarizeDesktopUpdateChildOutput(input: { stdout?: string; stderr?: string }, maxLength = 1000): string | null {
  const stderr = normalizeDiagnosticLines(input.stderr ?? "").join("\n");
  if (stderr) return truncateDiagnostic(stderr, maxLength);

  const stdout = normalizeDiagnosticLines(input.stdout ?? "")
    .filter((line) => !isDesktopProgressJsonLine(line))
    .join("\n");
  return stdout ? truncateDiagnostic(stdout, maxLength) : null;
}

function normalizeDiagnosticLines(value: string): string[] {
  return value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isDesktopProgressJsonLine(value: string): boolean {
  try {
    const payload = JSON.parse(value) as unknown;
    return typeof payload === "object"
      && payload !== null
      && "source" in payload
      && (payload as { source?: unknown }).source === "rudder-desktop-update";
  } catch {
    return false;
  }
}

function truncateDiagnostic(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `...${value.slice(value.length - Math.max(0, maxLength - 3))}`;
}
