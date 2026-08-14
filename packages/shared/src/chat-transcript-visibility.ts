export type ChatTranscriptLifecycleCandidate = {
  kind: string;
  text: string;
};

function compactTranscriptWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Lifecycle entries that remain useful as provenance boundaries but are not
 * rendered as user-selectable Process prose.
 *
 * Keep this predicate shared by the UI projection and server-side annotation
 * validation so hidden entries cannot split an internal protocol marker into a
 * server-visible fragment.
 */
export function isInternalChatTranscriptLifecycleEntry(
  entry: ChatTranscriptLifecycleCandidate,
) {
  if (entry.kind !== "system") return false;
  const text = compactTranscriptWhitespace(entry.text).toLowerCase();
  return text === "reasoning started"
    || text === "reasoning completed"
    || text === "pi agent started"
    || text === "pi agent finished"
    || text === "turn ended"
    || /^item (?:started|completed): reasoning(?:\s+\([^)]*\))?$/.test(text)
    || /^item (?:started|completed): user[_-]?message(?:\s+\([^)]*\))?$/.test(text);
}
