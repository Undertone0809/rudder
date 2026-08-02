import { parseMentionChipHref } from "./mention-chips";

const INLINE_CARET_BOUNDARY = "\u200B";
const CANONICAL_REFERENCE_RE = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;

export function normalizePlainTextComposerMarkdown(
  value: string,
  canonicalSource = value,
) {
  let normalized = value;
  let removedLength = 0;

  for (const match of value.matchAll(CANONICAL_REFERENCE_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length - removedLength;
    const href = match[2] ?? "";
    if (!parseMentionChipHref(href) && !href.trim().startsWith("skill://")) continue;

    const entity = normalized.slice(end).match(/^(?:(?:&amp;|&#x26;)#x20;|&#x20;)/iu)?.[0];
    if (
      entity
      && canonicalSource.slice(0, end) === normalized.slice(0, end)
      && canonicalSource[end] === " "
    ) {
      // MDXEditor's serializer may encode a canonical token's existing
      // boundary space. Only repair it when the known source proves that the
      // character was a space; user-authored entities remain untouched.
      normalized = `${normalized.slice(0, end)} ${normalized.slice(end + entity.length)}`;
      removedLength += entity.length - 1;
    }
  }

  return normalized
    .replaceAll(INLINE_CARET_BOUNDARY, "")
    .replace(/\\([\\`*_[\]{}()#+\-.!|>])/g, "$1");
}
