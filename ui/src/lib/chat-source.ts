import type { ChatConversation } from "@rudderhq/shared";

export function isFeishuBackedConversation(conversation: Pick<ChatConversation, "sourceMetadata"> | null | undefined) {
  const metadata = conversation?.sourceMetadata;
  return Boolean(
    metadata
    && typeof metadata === "object"
    && !Array.isArray(metadata)
    && metadata.source === "agent_integration"
    && metadata.provider === "feishu",
  );
}
