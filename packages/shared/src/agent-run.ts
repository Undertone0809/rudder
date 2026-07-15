import type {
  AgentRunScene,
  AgentRunTargetType,
} from "./constants.js";
import type { AgentRun, HeartbeatRun } from "./types/heartbeat.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
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

function resolveScene(run: HeartbeatRun, context: Record<string, unknown>): AgentRunScene {
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

function resolveTargetType(run: HeartbeatRun, context: Record<string, unknown>): AgentRunTargetType {
  if (isAgentRunTargetType(context.targetType)) return context.targetType;
  if (run.chatConversationId || stringValue(context.conversationId)) return "chat_conversation";
  if (stringValue(context.automationRunId)) return "automation_run";
  if (stringValue(context.issueId)) return "issue";
  if (run.wakeupRequestId || stringValue(context.wakeupRequestId)) return "wakeup_request";
  return "wakeup_request";
}

function resolveTargetId(
  run: HeartbeatRun,
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

export function toAgentRun(run: HeartbeatRun): AgentRun {
  const publicRun = toHeartbeatRun(run);
  const context = asRecord(publicRun.contextSnapshot);
  const targetType = resolveTargetType(publicRun, context);
  const conversationId = publicRun.chatConversationId ?? stringValue(context.conversationId);
  const messageId = stringValue(context.messageId)
    ?? stringValue(context.assistantMessageId)
    ?? stringValue(context.userMessageId);

  return {
    ...publicRun,
    scene: resolveScene(publicRun, context),
    triggerKind: stringValue(context.triggerKind) ?? publicRun.triggerDetail ?? publicRun.invocationSource,
    targetType,
    targetId: resolveTargetId(publicRun, context, targetType),
    conversationId,
    messageId,
    automationRunId: stringValue(context.automationRunId),
    automationId: stringValue(context.automationId),
    wakeupRequestId: publicRun.wakeupRequestId ?? stringValue(context.wakeupRequestId),
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
    contextSnapshot: run.contextSnapshot,
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
  return toAgentRun(run).scene;
}
