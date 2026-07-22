import type { AgentRunOrigin } from "../agent-run.js";
import type {
  MessengerSystemThreadKind as MessengerSystemThreadKindBase,
  MessengerThreadKind,
} from "../constants.js";
import type { JoinRequest } from "./access.js";
import type { Agent } from "./agent.js";
import type { Approval } from "./approval.js";
import type { BudgetIncident } from "./budget.js";
import type { ChatConversation, ChatMessage } from "./chat.js";
import type { HeartbeatRun } from "./heartbeat.js";
import type { Issue } from "./issue.js";

export interface MessengerThreadUserState {
  id: string;
  orgId: string;
  userId: string;
  threadKey: string;
  lastReadAt: Date;
  pinnedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessengerCustomGroup {
  id: string;
  orgId: string;
  userId: string;
  name: string;
  icon: string | null;
  sortOrder: number;
  collapsed: boolean;
  pinnedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessengerCustomGroupEntry {
  id: string;
  orgId: string;
  userId: string;
  groupId: string;
  /** Canonical opaque directory key. Persisted in the legacy `thread_key` column. */
  itemKey: string;
  /** Compatibility alias for thread-backed entries; Saved View JSON omits it. */
  threadKey?: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export type MessengerSavedViewTarget =
  | { kind: "browser"; tabId: string; url: string; viewInstanceId: string }
  | { kind: "automation"; automationId: string; viewInstanceId: string }
  | { kind: "library_document"; documentId: string; viewInstanceId: string }
  | { kind: "library_entry"; entryId: string; path: string; viewInstanceId: string }
  | { kind: "library_file"; filePath: string; viewInstanceId: string }
  | { kind: "library_directory"; directoryPath: string; viewInstanceId: string }
  | {
    kind: "local_app";
    desktopInstallationId: string;
    appPublicId: string;
    localBindingId: string;
    viewInstanceId: string;
  };

export type MessengerSavedViewTargetKind = MessengerSavedViewTarget["kind"];

export interface MessengerSavedView {
  id: string;
  orgId: string;
  userId: string;
  targetKind: MessengerSavedViewTargetKind;
  targetPayload: MessengerSavedViewTarget;
  resourceKey: string;
  instanceId: string;
  canonicalResourceKey: string;
  clientMutationId: string | null;
  title: string;
  subtitle: string | null;
  favicon: string | null;
  sortOrder: number;
  /** Non-null only for legacy rows; current mutations may restore but never hide. */
  hiddenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MessengerSavedViewPlacement =
  | { kind: "anchor"; anchor: { kind: "chat"; conversationId: string } | { kind: "issue"; issueId: string } }
  | { kind: "group"; groupId: string };

export interface MessengerSavedViewKeepResult {
  savedView: MessengerSavedView;
  group: Pick<MessengerCustomGroup, "id" | "name">;
}

export interface MessengerSavedViewPageInfo {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
}

export interface MessengerSavedViewPage {
  items: MessengerSavedView[];
  pageInfo: MessengerSavedViewPageInfo;
}

export type MessengerDirectoryItem =
  | {
    type: "thread";
    itemKey: string;
    title: string;
    thread: MessengerThreadSummary;
  }
  | {
    type: "saved_view";
    itemKey: string;
    title: string;
    savedView: MessengerSavedView;
  };

export interface MessengerCustomGroupHydratedThreadEntry extends MessengerCustomGroupEntry {
  item: Extract<MessengerDirectoryItem, { type: "thread" }>;
  threadKey: string;
  thread: MessengerThreadSummary;
}

export interface MessengerCustomGroupHydratedSavedViewEntry extends MessengerCustomGroupEntry {
  item: Extract<MessengerDirectoryItem, { type: "saved_view" }>;
  threadKey?: never;
  thread?: never;
}

export type MessengerCustomGroupHydratedEntry =
  | MessengerCustomGroupHydratedThreadEntry
  | MessengerCustomGroupHydratedSavedViewEntry;

export interface MessengerCustomGroupWithEntries extends MessengerCustomGroup {
  entries: MessengerCustomGroupHydratedEntry[];
}

export interface MessengerCustomGroupsResponse {
  groups: MessengerCustomGroupWithEntries[];
}

export interface IssueFollow {
  id: string;
  orgId: string;
  issueId: string;
  userId: string;
  createdAt: Date;
}

export interface IssueFollowEntry extends IssueFollow {
  issue: Pick<
    Issue,
    "id" | "identifier" | "title" | "status" | "priority" | "assigneeAgentId" | "assigneeUserId" | "reviewerUserId" | "createdByUserId" | "updatedAt"
  >;
}

export type MessengerSystemThreadKind = MessengerSystemThreadKindBase;

export interface MessengerThreadAction {
  label: string;
  href: string | null;
  method: "GET" | "POST" | "DELETE" | null;
}

export interface MessengerThreadSummary {
  threadKey: string;
  kind: MessengerThreadKind;
  title: string;
  subtitle: string | null;
  preview: string | null;
  latestActivityAt: Date | null;
  lastReadAt: Date | null;
  unreadCount: number;
  needsAttention: boolean;
  isPinned: boolean;
  href: string;
  metadata?: Record<string, unknown>;
}

export interface MessengerThreadPageInfo {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface MessengerThreadSummaryPage {
  items: MessengerThreadSummary[];
  pageInfo: MessengerThreadPageInfo;
}

export interface MessengerThreadDetail<TItem = MessengerThreadItem> extends MessengerThreadSummary {
  description: string | null;
  items: TItem[];
  pageInfo?: MessengerThreadPageInfo;
}

export interface MessengerEvent {
  id: string;
  threadKey: string;
  kind: MessengerThreadSummary["kind"];
  title: string;
  subtitle: string | null;
  body: string | null;
  preview: string | null;
  href: string | null;
  latestActivityAt: Date;
  actions: MessengerThreadAction[];
  metadata: Record<string, unknown>;
}

export interface MessengerThreadItem extends MessengerEvent {}

export interface MessengerChatThreadDetail {
  conversation: ChatConversation;
  messages: ChatMessage[];
}

export interface MessengerIssueThreadItem extends MessengerThreadItem {
  issueId: string;
  issueIdentifier: string | null;
  sourceCommentId: string | null;
  sourceCommentAuthorLabel: string | null;
  sourceCommentBody: string | null;
}

export interface MessengerApprovalThreadItem extends MessengerThreadItem {
  approval: Approval;
}

export interface MessengerBudgetThreadItem extends MessengerThreadItem {
  incident: BudgetIncident;
}

export interface MessengerJoinRequestThreadItem extends MessengerThreadItem {
  joinRequest: JoinRequest;
}

export type MessengerRunOriginSourceState = "available" | "source_unavailable" | "legacy_unknown";

export type MessengerRunOriginSource =
  | {
    kind: "chat";
    title: string;
    href: string;
  }
  | {
    kind: "issue" | "review";
    identifier: string | null;
    title: string;
    status: string;
    href: string;
  }
  | {
    kind: "automation";
    title: string;
    status: string;
    href: string;
  }
  | {
    kind: "heartbeat";
    agent: Pick<Agent, "id" | "name" | "icon" | "role" | "status" | "title">;
    href: string;
  }
  | {
    kind: "unavailable";
    state: Exclude<MessengerRunOriginSourceState, "available">;
  };

export interface MessengerRunOriginDescriptor extends AgentRunOrigin {
  targetLabel: string | null;
  targetStatus: string | null;
  sourceState: MessengerRunOriginSourceState;
  source: MessengerRunOriginSource;
}

export interface MessengerFailedRunThreadItem extends MessengerThreadItem {
  origin: MessengerRunOriginDescriptor;
}

/** @deprecated Use MessengerFailedRunThreadItem. */
export interface MessengerHeartbeatRunThreadItem extends MessengerThreadItem {
  run: HeartbeatRun;
}

export type MessengerSystemThreadItem = MessengerEvent | MessengerFailedRunThreadItem;
