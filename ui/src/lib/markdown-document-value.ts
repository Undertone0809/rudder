/**
 * Treat whitespace-only Markdown as empty without rewriting any non-empty
 * source. Document editors use the returned value as their canonical save
 * payload so leading/trailing newlines and indentation survive round trips.
 */
export function normalizeMarkdownDocumentValue(value: string): string {
  return value.trim().length === 0 ? "" : value;
}

export function markdownDocumentOrNull(value: string): string | null {
  const normalized = normalizeMarkdownDocumentValue(value);
  return normalized.length === 0 ? null : normalized;
}

export function markdownDocumentOrUndefined(value: string): string | undefined {
  const normalized = normalizeMarkdownDocumentValue(value);
  return normalized.length === 0 ? undefined : normalized;
}
