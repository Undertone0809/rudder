import type { MentionOption } from "@/components/MarkdownEditor";

type MentionTrigger = "@" | "$";

export const MENTION_OPTION_RENDER_LIMIT = 50;

function normalizedText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function searchableText(option: MentionOption) {
  return normalizedText([option.name, option.searchText].filter(Boolean).join(" "));
}

function hasWordPrefix(text: string, query: string) {
  return text
    .split(/[^a-z0-9]+/i)
    .some((part) => part.startsWith(query));
}

function mentionMatchRank(option: MentionOption, query: string) {
  if (!query) return 10;

  const name = normalizedText(option.name);
  const text = searchableText(option);

  if (name === query) return 0;
  if (name.startsWith(query)) return 1;

  if (option.kind === "library_file" && option.libraryFilePath) {
    const path = normalizedText(option.libraryFilePath);
    if (path.endsWith(`.${query}`)) return 2;
    if (path.split("/").some((part) => part.startsWith(query))) return 3;
  }

  if (hasWordPrefix(text, query)) return 4;
  if (text.includes(query)) return 5;

  return Number.POSITIVE_INFINITY;
}

function mentionKindPriority(option: MentionOption) {
  if (option.kind === "agent" || !option.kind) return 0;
  if (option.kind === "skill") return 1;
  if (option.kind === "project") return 2;
  if (option.kind === "issue") return 3;
  if (option.kind === "chat") return 4;
  return 5;
}

function isStrongLibraryFileMatch(entry: { mention: MentionOption; rank: number }) {
  return entry.mention.kind === "library_file" && entry.rank <= 3;
}

export function filterMentionOptions(
  mentions: MentionOption[] | null | undefined,
  trigger: MentionTrigger,
  query: string,
  limit = MENTION_OPTION_RENDER_LIMIT,
) {
  if (!mentions) return [];
  const normalizedQuery = normalizedText(query);

  return mentions
    .map((mention, index) => {
      if (trigger === "$" && mention.kind !== "skill") {
        return null;
      }
      const rank = mentionMatchRank(mention, normalizedQuery);
      if (!Number.isFinite(rank)) return null;
      return { mention, rank, index };
    })
    .filter((entry): entry is { mention: MentionOption; rank: number; index: number } => entry !== null)
    .sort((left, right) => {
      const leftStrongLibraryFile = isStrongLibraryFileMatch(left);
      const rightStrongLibraryFile = isStrongLibraryFileMatch(right);
      if (leftStrongLibraryFile !== rightStrongLibraryFile) return leftStrongLibraryFile ? -1 : 1;
      const leftKindPriority = mentionKindPriority(left.mention);
      const rightKindPriority = mentionKindPriority(right.mention);
      if (leftKindPriority !== rightKindPriority) return leftKindPriority - rightKindPriority;
      if (left.rank !== right.rank) return left.rank - right.rank;
      return left.index - right.index;
    })
    .slice(0, limit)
    .map((entry) => entry.mention);
}
