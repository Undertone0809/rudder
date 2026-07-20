import type { ChatWorkManifestCategory } from "../chat-work-manifest.js";
import type { ChatConversationMutability } from "../constants.js";
import type { Approval } from "./approval.js";

export interface ChatLinkedEntity {
  type: "issue" | "project" | "agent";
  id: string;
  label: string;
  subtitle: string | null;
  identifier: string | null;
  status: string | null;
  description?: string | null;
  priority?: string | null;
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
  provider?: string;
  objectKey?: string;
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
  sourceType: "agent" | "unconfigured";
  sourceLabel: string;
  runtimeAgentId: string | null;
  agentRuntimeType: string | null;
  model: string | null;
  available: boolean;
  error: string | null;
}

export type ChatGenerationStatus =
  | "starting"
  | "active"
  | "running"
  | "tool_busy"
  | "closing"
  | "stop_requested"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped"
  | "aborted"
  | "interrupted_unverified"
  | "control_lost";

export type ChatGenerationControlState =
  | "unregistered"
  | "ready"
  | "stopping"
  | "terminal"
  | "control_lost";

export type ChatQueueDeliveryIntent = "queue" | "steer";

export interface ChatQueueRequestActor {
  type: "board" | "agent";
  source: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt";
  userId?: string;
  orgIds?: string[];
  orgId?: string;
  isInstanceAdmin?: boolean;
  agentId?: string;
  runId?: string;
  adapterType?: string;
}

export type ChatControlDisposition =
  | "pending"
  | "accepted_current"
  | "acceptance_unknown"
  | "reconciled_current"
  | "continuation_pending"
  | "waiting_safe_boundary"
  | "running_next"
  | "delivered"
  | "stop_requested"
  | "stopping"
  | "stopped"
  | "interrupted_unverified"
  | "cancellation_unverified"
  | "control_lost"
  | "failed_actionable"
  | "cancelled";

export type ChatProviderControlDisposition =
  | "not_sent"
  | "sent"
  | "acknowledged"
  | "rejected"
  | "timed_out"
  | "connection_lost"
  | "waiting_safe_boundary"
  | "unverified";

export type ChatControlActionKind = "stop" | "steer";

export type ChatGenerationEventKind =
  | "generation_started"
  | "runtime_output"
  | "assistant_delta"
  | "transcript"
  | "client_checkpoint"
  | "steer_requested"
  | "steer_provider_sent"
  | "steer_acknowledged"
  | "continuation_scheduled"
  | "stop_requested"
  | "output_cutoff"
  | "runtime_terminal"
  | "late_output_dropped"
  | "terminal_projection_requested"
  | "terminal_projected";

export type ChatTerminalOutboxStatus =
  | "pending"
  | "claimed"
  | "retry_wait"
  | "projected"
  | "superseded"
  | "failed_actionable";

export type ChatQueuedMessageStatus =
  | "queued"
  | "steer_pending"
  | "accepted_current"
  | "acceptance_unknown"
  | "reconciled_current"
  | "continuation_pending"
  | "running_next"
  | "delivered"
  | "failed_actionable"
  // Legacy delivery states remain readable while existing rows are migrated.
  | "steered"
  | "dequeue_claimed"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export type ChatSteerResult =
  | "delivered_current"
  | "scheduled_next"
  | "acceptance_unknown"
  | "failed_actionable"
  // Legacy route outcomes remain temporarily representable during cutover.
  | "accepted"
  | "pending"
  | "queued_fallback"
  | "stale_generation"
  | "closing"
  | "unsupported";

export interface ChatQueuedMessagePayload {
  body: string;
  attachmentIds?: string[];
  projectId?: string | null;
  skillRefs?: string[];
  accessMode?: string | null;
  model?: string | null;
  effort?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ChatQueuedMessage {
  id: string;
  orgId: string;
  conversationId: string;
  position: number;
  status: ChatQueuedMessageStatus;
  version: number;
  clientMutationId: string;
  payload: ChatQueuedMessagePayload;
  requestActor?: ChatQueueRequestActor | null;
  deliveryIntent: ChatQueueDeliveryIntent;
  deliveryDisposition: ChatControlDisposition | null;
  controlActionId: string | null;
  expectedGenerationId: string | null;
  activeGenerationId: string | null;
  attemptEpoch: number | null;
  providerClientMessageId: string | null;
  providerThreadId: string | null;
  providerTurnId: string | null;
  providerEvidence: Record<string, unknown> | null;
  continuationGenerationId: string | null;
  continuationMessageId: string | null;
  deliveryLeaseToken: string | null;
  deliveryLeaseEpoch: number;
  deliveryLeaseOwner: string | null;
  deliveryLeaseExpiresAt: Date | null;
  reconciliationReason: string | null;
  deliveryAttempts: number;
  lastAttemptAt: Date | null;
  lastDeliveryReason: string | null;
  sourceMessageId: string | null;
  deliveredMessageId: string | null;
  cancelledAt: Date | null;
  steeredAt: Date | null;
  dequeuedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatQueueSnapshot {
  activeGenerationId: string | null;
  activeAttemptEpoch: number | null;
  activeControlVersion: number | null;
  activeGenerationStatus: ChatGenerationStatus | null;
  items: ChatQueuedMessage[];
}

export interface ChatQueueClaimResponse {
  item: ChatQueuedMessage | null;
}

export interface ChatSteerResponse {
  item: ChatQueuedMessage;
  result: ChatSteerResult;
  disposition?: ChatControlDisposition;
  controlActionId?: string;
  activeGenerationId: string | null;
  queueVersion: number;
  transcriptEventId: string | null;
}

export interface ChatGeneration {
  id: string;
  orgId: string;
  conversationId: string;
  status: ChatGenerationStatus;
  terminalReason: string | null;
  attemptEpoch: number;
  controlVersion: number;
  controlState: ChatGenerationControlState;
  controlRuntimeType: string | null;
  controlOwnerToken: string | null;
  controlLeaseExpiresAt: Date | null;
  providerThreadId: string | null;
  providerTurnId: string | null;
  acceptedThroughSeq: number | null;
  lastClientCheckpointSeq: number | null;
  lastClientCheckpointHash: string | null;
  frozenBodyHash: string | null;
  stopRequestedAt: Date | null;
  runtimeTerminalAt: Date | null;
  lateEventsDropped: number;
  lateBytes: number;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatControlAction {
  id: string;
  orgId: string;
  expectedGenerationId: string | null;
  expectedAttemptEpoch: number | null;
  expectedControlVersion: number | null;
  appliedControlVersion: number | null;
  actionKind: ChatControlActionKind;
  localDisposition: ChatControlDisposition;
  providerDisposition: ChatProviderControlDisposition | null;
  controlOwnerToken: string | null;
  providerClientMessageId: string | null;
  providerThreadId: string | null;
  providerTurnId: string | null;
  providerEvidence: Record<string, unknown> | null;
  requestedRenderSeq: number | null;
  requestedBodyHash: string | null;
  acceptedThroughSeq: number | null;
  frozenBodyHash: string | null;
  lastError: string | null;
  requestedAt: Date;
  providerSentAt: Date | null;
  providerAcknowledgedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatGenerationEvent {
  id: string;
  orgId: string;
  generationId: string;
  generationSeq: number;
  attemptEpoch: number;
  eventKind: ChatGenerationEventKind;
  payload: Record<string, unknown>;
  bodyOffset: number | null;
  bodyLength: number | null;
  assistantMessageId: string | null;
  runId: string | null;
  controlActionId: string | null;
  queueItemId: string | null;
  recordedAt: Date;
  emittedAt: Date | null;
}

export interface ChatGenerationTerminalOutboxEntry {
  id: string;
  orgId: string;
  generationId: string;
  sourceEventId: string;
  projectionVersion: number;
  projectorVersion: number;
  expectedControlVersion: number;
  status: ChatTerminalOutboxStatus;
  payload: Record<string, unknown>;
  claimToken: string | null;
  claimEpoch: number;
  claimOwner: string | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
  replayCount: number;
  availableAt: Date;
  lastAttemptAt: Date | null;
  lastError: string | null;
  projectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatConversation {
  id: string;
  orgId: string;
  status: "active" | "resolved" | "archived";
  conversationKind?: "chat" | "side_chat";
  messengerVisible?: boolean;
  sideChatState?: "active" | "completed" | "expired" | "kept" | null;
  sideChatExpiresAt?: Date | null;
  sideChatCompletedAt?: Date | null;
  sideChatKeptAt?: Date | null;
  sideChatClientMutationId?: string | null;
  mutability: ChatConversationMutability;
  title: string;
  summary: string | null;
  latestReplyPreview: string | null;
  latestUserMessagePreview: string | null;
  userMessageCount: number;
  searchPreview?: string | null;
  preferredAgentId: string | null;
  routedAgentId: string | null;
  primaryIssueId: string | null;
  forkedFromConversationId: string | null;
  forkedFromMessageId: string | null;
  forkRootConversationId: string | null;
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
  sourceMetadata?: Record<string, unknown> | null;
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
    | "ask_user"
    | "issue_proposal"
    | "operation_proposal"
    | "system_event";
  status: "streaming" | "completed" | "stopped" | "failed" | "interrupted";
  body: string;
  structuredPayload: Record<string, unknown> | null;
  approvalId: string | null;
  approval: Approval | null;
  attachments: ChatAttachment[];
  transcript?: ChatStreamTranscriptEntry[];
  transcriptSummary?: ChatTranscriptSummary | null;
  /** Agent run that produced this assistant message, when generated by a real runtime. */
  runId?: string | null;
  /** Agent whose runtime produced this assistant message. */
  replyingAgentId: string | null;
  /** Groups user+assistant rows for one logical turn; new variant on edit/regenerate. */
  chatTurnId: string | null;
  turnVariant: number;
  supersededAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ChatWorkManifestTargetType =
  | "attachment"
  | "automation"
  | "chat_conversation"
  | "external_url"
  | "issue"
  | "issue_comment"
  | "library_entry"
  | "library_file"
  | "project_resource";

export interface ChatWorkManifestItem {
  id: string;
  orgId: string;
  conversationId: string;
  projectId: string | null;
  messageId: string | null;
  runId: string | null;
  category: ChatWorkManifestCategory;
  targetType: ChatWorkManifestTargetType;
  targetKey: string;
  title: string;
  url: string | null;
  status: "ready" | "unavailable" | "hidden";
  sourceRole: "user" | "assistant" | "project" | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatWorkManifestResponse {
  conversationId: string;
  totalCount: number;
  outputs: ChatWorkManifestItem[];
  sources: ChatWorkManifestItem[];
  references: ChatWorkManifestItem[];
  project: {
    id: string;
    totalCount: number;
  } | null;
}

export interface ChatTranscriptSummary {
  entryCount: number;
  startedAt: string | null;
  endedAt: string | null;
}

export type ChatRichReferenceDisplay = "card" | "inline";

export interface ChatAskUserOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface ChatAskUserQuestion {
  id: string;
  header?: string;
  question: string;
  options: ChatAskUserOption[];
  selectionMode?: "single" | "multiple";
  allowFreeform?: boolean;
}

export interface ChatAskUserRequest {
  questions: ChatAskUserQuestion[];
}

export type ChatRichReference =
  | {
    type: "issue";
    issueId?: string;
    identifier?: string;
    display?: ChatRichReferenceDisplay;
  }
  | {
    type: "issue_comment";
    issueId?: string;
    identifier?: string;
    commentId: string;
    display?: ChatRichReferenceDisplay;
  };

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
  | { kind: "todo_list"; ts: string; todoListId?: string; items: ChatStreamTranscriptTodoItem[] }
  | { kind: "init"; ts: string; model: string; sessionId: string }
  | { kind: "result"; ts: string; text: string; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; subtype: string; isError: boolean; errors: string[] }
  | { kind: "stderr"; ts: string; text: string }
  | { kind: "system"; ts: string; text: string }
  | { kind: "stdout"; ts: string; text: string };

export type ChatStreamTranscriptTodoItemStatus = "pending" | "in_progress" | "completed";

export interface ChatStreamTranscriptTodoItem {
  text: string;
  status: ChatStreamTranscriptTodoItemStatus;
}

export interface ChatStreamAckEvent {
  type: "ack";
  userMessage: ChatMessage;
  /** Present only when this acknowledgement atomically accepted a draft's first turn. */
  conversation?: ChatConversation;
  generationId?: string;
  attemptEpoch?: number;
  generationSeq?: number;
  bodyHash?: string;
}

export interface ChatStreamAssistantDeltaEvent {
  type: "assistant_delta";
  delta: string;
  generationId?: string;
  attemptEpoch?: number;
  generationSeq?: number;
  bodyHash?: string;
}

export interface ChatStreamAssistantStateEvent {
  type: "assistant_state";
  state: "streaming" | "finalizing" | "stopped";
}

export interface ChatStreamTranscriptEntryEvent {
  type: "transcript_entry";
  entry: ChatStreamTranscriptEntry;
  generationId?: string;
  attemptEpoch?: number;
  generationSeq?: number;
  bodyHash?: string;
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

export interface ChatStreamQueuedEvent {
  type: "queued";
  item: ChatQueuedMessage;
}

export type ChatStreamEvent =
  | ChatStreamAckEvent
  | ChatStreamAssistantDeltaEvent
  | ChatStreamAssistantStateEvent
  | ChatStreamTranscriptEntryEvent
  | ChatStreamFinalEvent
  | ChatStreamErrorEvent
  | ChatStreamQueuedEvent;
