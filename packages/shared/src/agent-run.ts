import type {
  AgentRunScene,
  AgentRunTargetType,
} from "./constants.js";
import type { AgentRun, HeartbeatRun, HeartbeatRunContextSnapshot } from "./types/heartbeat.js";

export interface AgentRunOriginInput {
  id: string;
  invocationSource: string;
  triggerDetail: string | null;
  wakeupRequestId: string | null;
  chatConversationId?: string | null;
  contextSnapshot: HeartbeatRunContextSnapshot | Record<string, unknown> | null;
}

export interface AgentRunOrigin {
  runId: string;
  scene: AgentRunScene;
  targetType: AgentRunTargetType;
  targetId: string | null;
  triggerKind: string;
  invocationSource: string;
  conversationId: string | null;
  messageId: string | null;
  issueId: string | null;
  automationRunId: string | null;
  automationId: string | null;
  wakeupRequestId: string | null;
}

export interface AgentRunOverview {
  latestByAgent: AgentRun[];
  recent: AgentRun[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function toPublicHeartbeatRunContextSnapshot(
  value: HeartbeatRun["contextSnapshot"],
): HeartbeatRun["contextSnapshot"] {
  if (!value) return null;
  const context = { ...value };
  delete context.resumeSessionParams;
  delete context.resumeSessionDisplayId;
  delete context.forceFreshSession;
  delete context.sessionResumeSuppressed;
  return context;
}

function isAgentRunScene(value: unknown): value is AgentRunScene {
  return value === "issue"
    || value === "chat"
    || value === "automation"
    || value === "review"
    || value === "heartbeat";
}

function isAgentRunTargetType(value: unknown): value is AgentRunTargetType {
  return value === "issue"
    || value === "chat_conversation"
    || value === "chat_message"
    || value === "automation_run"
    || value === "wakeup_request"
    || value === "manual";
}

function resolveScene(run: AgentRunOriginInput, context: Record<string, unknown>): AgentRunScene {
  if (isAgentRunScene(context.scene)) return context.scene;
  if (isAgentRunScene(context.rudderScene)) return context.rudderScene;
  if (run.invocationSource === "chat" || run.chatConversationId || stringValue(context.conversationId)) return "chat";
  if (run.invocationSource === "review") return "review";
  if (run.invocationSource === "timer") return "heartbeat";
  if (stringValue(context.automationRunId)) return "automation";
  if (stringValue(context.issueId)) return "issue";
  if (run.invocationSource === "automation") return "automation";
  return "heartbeat";
}

function resolveTargetType(run: AgentRunOriginInput, context: Record<string, unknown>): AgentRunTargetType {
  if (isAgentRunTargetType(context.targetType)) return context.targetType;
  if (run.chatConversationId || stringValue(context.conversationId)) return "chat_conversation";
  if (stringValue(context.automationRunId)) return "automation_run";
  if (stringValue(context.issueId)) return "issue";
  if (run.wakeupRequestId || stringValue(context.wakeupRequestId)) return "wakeup_request";
  return "wakeup_request";
}

function resolveTargetId(
  run: AgentRunOriginInput,
  context: Record<string, unknown>,
  targetType: AgentRunTargetType,
): string | null {
  const explicit = stringValue(context.targetId);
  if (explicit) return explicit;
  if (targetType === "chat_conversation") return run.chatConversationId ?? stringValue(context.conversationId);
  if (targetType === "chat_message") return stringValue(context.messageId) ?? stringValue(context.assistantMessageId) ?? stringValue(context.userMessageId);
  if (targetType === "automation_run") return stringValue(context.automationRunId);
  if (targetType === "issue") return stringValue(context.issueId);
  if (targetType === "wakeup_request") return run.wakeupRequestId ?? stringValue(context.wakeupRequestId);
  return null;
}

function resolveTriggerKind(run: AgentRunOriginInput, context: Record<string, unknown>): string {
  const explicit = stringValue(context.triggerKind);
  if (explicit) return explicit;

  const wakeReason = stringValue(context.wakeReason);
  const wakeSource = stringValue(context.wakeSource);
  if (
    stringValue(context.commentId)
    || wakeSource === "issue.comment"
    || wakeReason === "issue_commented"
    || wakeReason === "issue_comment_mentioned"
  ) {
    return "issue_comment";
  }
  if (run.invocationSource === "review") return "review_routing";
  if (run.invocationSource === "timer") return "timer";
  if (run.invocationSource === "on_demand" && run.triggerDetail === "manual") return "manual";
  return run.triggerDetail ?? run.invocationSource;
}

/**
 * Projects only canonical Agent Run provenance fields from compatibility run storage.
 *
 * Reasoning:
 * - Every product surface must share one scene/target precedence instead of
 *   interpreting the historical `heartbeat_runs` table independently.
 * - The returned shape is an allowlist: callers can route and label an origin
 *   without forwarding the raw context snapshot or session/runtime details.
 *
 * Traceability:
 * - RUN.AGENT.UNIFICATION.001
 * - MESSENGER.ATTENTION.001
 */
export function toAgentRunOrigin(run: AgentRunOriginInput): AgentRunOrigin {
  const context = asRecord(run.contextSnapshot);
  const targetType = resolveTargetType(run, context);
  const targetId = resolveTargetId(run, context, targetType);
  const conversationId = run.chatConversationId ?? stringValue(context.conversationId);
  const messageId = stringValue(context.messageId)
    ?? stringValue(context.assistantMessageId)
    ?? stringValue(context.userMessageId);
  const issueId = stringValue(context.issueId)
    ?? (targetType === "issue" ? targetId : null);

  return {
    runId: run.id,
    scene: resolveScene(run, context),
    triggerKind: resolveTriggerKind(run, context),
    targetType,
    targetId,
    invocationSource: run.invocationSource,
    conversationId,
    messageId,
    issueId,
    automationRunId: stringValue(context.automationRunId),
    automationId: stringValue(context.automationId),
    wakeupRequestId: run.wakeupRequestId ?? stringValue(context.wakeupRequestId),
  };
}

export function toAgentRun(run: HeartbeatRun): AgentRun {
  const publicRun = toHeartbeatRun(run);
  const origin = toAgentRunOrigin(publicRun);

  return {
    ...publicRun,
    scene: origin.scene,
    triggerKind: origin.triggerKind,
    targetType: origin.targetType,
    targetId: origin.targetId,
    conversationId: origin.conversationId,
    messageId: origin.messageId,
    issueId: origin.issueId,
    automationRunId: origin.automationRunId,
    automationId: origin.automationId,
    wakeupRequestId: origin.wakeupRequestId,
  };
}

export function toHeartbeatRun(run: HeartbeatRun): HeartbeatRun {
  return {
    id: run.id,
    orgId: run.orgId,
    agentId: run.agentId,
    invocationSource: run.invocationSource,
    triggerDetail: run.triggerDetail,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    wakeupRequestId: run.wakeupRequestId,
    exitCode: run.exitCode,
    signal: run.signal,
    usageJson: run.usageJson,
    resultJson: run.resultJson,
    sessionIdBefore: run.sessionIdBefore,
    sessionIdAfter: run.sessionIdAfter,
    sessionReuseScope: run.sessionReuseScope ?? "unknown",
    logStore: run.logStore,
    logRef: run.logRef,
    logBytes: run.logBytes,
    logSha256: run.logSha256,
    logCompressed: run.logCompressed,
    stdoutExcerpt: run.stdoutExcerpt,
    stderrExcerpt: run.stderrExcerpt,
    errorCode: run.errorCode,
    externalRunId: run.externalRunId,
    chatConversationId: run.chatConversationId ?? null,
    processPid: run.processPid,
    processStartedAt: run.processStartedAt,
    retryOfRunId: run.retryOfRunId,
    processLossRetryCount: run.processLossRetryCount,
    contextSnapshot: toPublicHeartbeatRunContextSnapshot(run.contextSnapshot),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export function toHeartbeatRuns(runs: HeartbeatRun[]): HeartbeatRun[] {
  return runs.map(toHeartbeatRun);
}

export function toAgentRuns(runs: HeartbeatRun[]): AgentRun[] {
  return runs.map(toAgentRun);
}

export function resolveAgentRunScene(run: HeartbeatRun): AgentRunScene {
  return toAgentRunOrigin(run).scene;
}
