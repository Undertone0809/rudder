import type { Approval } from "./approval.js";

export interface ChatLinkedEntity {
  type: "issue" | "project" | "agent";
  id: string;
  label: string;
  subtitle: string | null;
  identifier: string | null;
  status: string | null;
  href: string;
}

export interface ChatContextLink {
  id: string;
  orgId: string;
  conversationId: string;
  entityType: "issue" | "project" | "agent";
  entityId: string;
  metadata: Record<string, unknown> | null;
  entity: ChatLinkedEntity | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatAttachment {
  id: string;
  orgId: string;
  conversationId: string;
  messageId: string;
  assetId: string;
  provider: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  contentPath: string;
}

export interface ChatPrimaryIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
}

export interface ChatRuntimeDescriptor {
  sourceType: "agent" | "copilot" | "unconfigured";
  sourceLabel: string;
  runtimeAgentId: string | null;
  agentRuntimeType: string | null;
  model: string | null;
  available: boolean;
  error: string | null;
}

export interface ChatConversation {
  id: string;
  orgId: string;
  status: "active" | "resolved" | "archived";
  title: string;
  summary: string | null;
  latestReplyPreview: string | null;
  preferredAgentId: string | null;
  routedAgentId: string | null;
  primaryIssueId: string | null;
  primaryIssue: ChatPrimaryIssueSummary | null;
  issueCreationMode: "manual_approval" | "auto_create";
  planMode: boolean;
  createdByUserId: string | null;
  lastMessageAt: Date | null;
  lastReadAt: Date | null;
  isPinned: boolean;
  isUnread: boolean;
  unreadCount: number;
  needsAttention: boolean;
  resolvedAt: Date | null;
  contextLinks: ChatContextLink[];
  chatRuntime: ChatRuntimeDescriptor;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessage {
  id: string;
  orgId: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  kind:
    | "message"
    | "issue_proposal"
    | "operation_proposal"
    | "routing_suggestion"
    | "system_event";
  status: "completed" | "stopped" | "failed";
  body: string;
  structuredPayload: Record<string, unknown> | null;
  approvalId: string | null;
  approval: Approval | null;
  attachments: ChatAttachment[];
  transcript?: ChatStreamTranscriptEntry[];
  /** Agent whose runtime produced this assistant message, including the hidden Copilot agent when used. */
  replyingAgentId: string | null;
  /** Groups user+assistant rows for one logical turn; new variant on edit/regenerate. */
  chatTurnId: string | null;
  turnVariant: number;
  supersededAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ChatOperationProposalDecisionAction = "approve" | "reject" | "requestRevision";

export type ChatOperationProposalDecisionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "revision_requested";

export interface ChatOperationProposalDecision {
  status: ChatOperationProposalDecisionStatus;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
}

export type ChatStreamTranscriptEntry =
  | { kind: "assistant"; ts: string; text: string; delta?: boolean }
  | { kind: "thinking"; ts: string; text: string; delta?: boolean }
  | { kind: "user"; ts: string; text: string }
  | { kind: "tool_call"; ts: string; name: string; input: unknown; toolUseId?: string }
  | { kind: "tool_result"; ts: string; toolUseId: string; toolName?: string; content: string; isError: boolean }
  | { kind: "init"; ts: string; model: string; sessionId: string }
  | { kind: "result"; ts: string; text: string; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; subtype: string; isError: boolean; errors: string[] }
  | { kind: "stderr"; ts: string; text: string }
  | { kind: "system"; ts: string; text: string }
  | { kind: "stdout"; ts: string; text: string };

export interface ChatStreamAckEvent {
  type: "ack";
  userMessage: ChatMessage;
}

export interface ChatStreamAssistantDeltaEvent {
  type: "assistant_delta";
  delta: string;
}

export interface ChatStreamAssistantStateEvent {
  type: "assistant_state";
  state: "streaming" | "finalizing" | "stopped";
}

export interface ChatStreamTranscriptEntryEvent {
  type: "transcript_entry";
  entry: ChatStreamTranscriptEntry;
}

export interface ChatStreamFinalEvent {
  type: "final";
  messages: ChatMessage[];
}

export interface ChatStreamErrorEvent {
  type: "error";
  error: string;
  messageId?: string | null;
}

export type ChatStreamEvent =
  | ChatStreamAckEvent
  | ChatStreamAssistantDeltaEvent
  | ChatStreamAssistantStateEvent
  | ChatStreamTranscriptEntryEvent
  | ChatStreamFinalEvent
  | ChatStreamErrorEvent;
