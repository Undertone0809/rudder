import { chatConversations } from "@rudderhq/db";
import type { ChatConversationMutability } from "@rudderhq/shared";
import type { ConversationSourceMetadata } from "./chats.types.js";

type ConversationRow = typeof chatConversations.$inferSelect;
const FORK_TITLE_SUFFIX_PATTERN = / \(([1-9]\d*)\)$/;
const CHAT_TITLE_MAX_LENGTH = 200;

function numberedForkTitle(baseTitle: string, index: number) {
  const suffix = ` (${index})`;
  const availableBaseLength = CHAT_TITLE_MAX_LENGTH - suffix.length;
  const truncatedBase = baseTitle.slice(0, availableBaseLength).trimEnd() || "Forked conversation";
  return `${truncatedBase}${suffix}`;
}

function baseForkTitle(title: string, sourceIsFork: boolean, familyTitles: Set<string>) {
  const trimmed = title.trim() || "Forked conversation";
  if (!sourceIsFork) return trimmed;
  const match = trimmed.match(FORK_TITLE_SUFFIX_PATTERN);
  const index = Number(match?.[1]);
  if (!match || index < 2) return trimmed;
  for (const familyTitle of familyTitles) {
    const candidateBase = familyTitle.trim();
    if (!candidateBase || candidateBase === trimmed) continue;
    if (numberedForkTitle(candidateBase, index) !== trimmed) continue;
    if (index === 2 || familyTitles.has(numberedForkTitle(candidateBase, index - 1))) return candidateBase;
  }
  return trimmed;
}

export function nextForkTitle(source: ConversationRow, familyTitles: string[]) {
  const existingTitles = new Set(familyTitles);
  const baseTitle = baseForkTitle(source.title, Boolean(source.forkedFromConversationId), existingTitles);
  let index = 2;
  while (existingTitles.has(numberedForkTitle(baseTitle, index))) index += 1;
  return numberedForkTitle(baseTitle, index);
}

export function conversationMutability(
  row: ConversationRow,
  sourceMetadata: ConversationSourceMetadata | null | undefined,
  sourceMetadataByConversationId: Map<string, ConversationSourceMetadata>,
): ChatConversationMutability {
  if (sourceMetadata) return "external_bound_chat";
  if (
    (row.forkedFromConversationId && sourceMetadataByConversationId.has(row.forkedFromConversationId))
    || (row.forkRootConversationId && sourceMetadataByConversationId.has(row.forkRootConversationId))
  ) {
    return "native_fork_from_external";
  }
  return "native_chat";
}
