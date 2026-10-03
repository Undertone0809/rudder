import { compactWhitespace } from "./RunTranscriptView.common";
import { cleanShellToken } from "./RunTranscriptView.shell";

export function normalizePathTarget(value: string): string | null {
  const normalized = cleanShellToken(compactWhitespace(value));
  if (!normalized) return null;
  if (/^(?:&&|\|\||[|;<>])$/.test(normalized)) return null;
  return normalized;
}

export function dedupeTargets(values: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizePathTarget(value);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}
