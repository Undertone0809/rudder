import type { AssistanceRequestResolution, RequestKind, RequestStatus } from "../constants.js";
import type { Approval } from "./approval.js";

export interface AssistanceRequest {
  id: string;
  orgId: string;
  kind: "assistance";
  subtype: "issue_blocker";
  status: RequestStatus;
  issueId: string;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  originRunId: string | null;
  assigneeAgentId: string | null;
  blockerFingerprint: string;
  supersededByRequestId: string | null;
  title: string;
  prompt: string;
  resolution: AssistanceRequestResolution | null;
  response: string | null;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalRequest extends Approval {
  kind: "approval";
  subtype: Approval["type"];
  requestStatus: RequestStatus;
}

export type RudderRequest = AssistanceRequest | ApprovalRequest;

export interface IssueBlockAuditResult {
  request: AssistanceRequest;
  attempt: number;
  requiredAttempts: 3;
  blocked: boolean;
  fingerprint: string;
  applied: boolean;
}

export type { RequestKind };
