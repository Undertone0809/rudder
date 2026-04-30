import type { Approval } from "./approval.js";
import type { ChatConversation, ChatMessage } from "./chat.js";
import type { Issue } from "./issue.js";
import type { BudgetIncident } from "./budget.js";
import type { JoinRequest } from "./access.js";
import type { HeartbeatRun } from "./heartbeat.js";
import type {
  MessengerSystemThreadKind as MessengerSystemThreadKindBase,
  MessengerThreadKind,
} from "../constants.js";

export interface MessengerThreadUserState {
  id: string;
  orgId: string;
  userId: string;
  threadKey: string;
  lastReadAt: Date;
  createdAt: Date;
  updatedAt: Date;
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
    "id" | "identifier" | "title" | "status" | "priority" | "assigneeAgentId" | "assigneeUserId" | "createdByUserId" | "updatedAt"
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
  href: string;
}

export interface MessengerThreadDetail<TItem = MessengerThreadItem> extends MessengerThreadSummary {
  description: string | null;
  items: TItem[];
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

export interface MessengerHeartbeatRunThreadItem extends MessengerThreadItem {
  run: HeartbeatRun;
}
