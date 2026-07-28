import { chatMessages } from "@rudderhq/db";
import type { ChatQueuedMessage } from "@rudderhq/shared";

type MessageRow = typeof chatMessages.$inferSelect;

export type ChatServerQueueClaim = {
  item: ChatQueuedMessage;
  generationId: string;
  userMessageId: string;
  leaseToken: string;
  leaseEpoch: number;
};

export type MessageHydrationRow = MessageRow & {
  transcriptSummary?: {
    entryCount: number;
    startedAt: string | null;
    endedAt: string | null;
  } | null;
};

export type ConversationSummaryCursor = {
  attentionRank: number;
  activityAt: Date;
  title: string;
  threadKey: string;
};

export type ConversationSourceMetadata = {
  source: "agent_integration";
  provider: string;
  integrationId: string;
  externalChatId: string;
  externalChatType: string;
};
