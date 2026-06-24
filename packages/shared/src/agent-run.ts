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
  const context = asRecord(run.contextSnapshot);
  const targetType = resolveTargetType(run, context);
  const conversationId = run.chatConversationId ?? stringValue(context.conversationId);
  const messageId = stringValue(context.messageId)
    ?? stringValue(context.assistantMessageId)
    ?? stringValue(context.userMessageId);

  return {
    ...run,
    scene: resolveScene(run, context),
    triggerKind: stringValue(context.triggerKind) ?? run.triggerDetail ?? run.invocationSource,
    targetType,
    targetId: resolveTargetId(run, context, targetType),
    conversationId,
    messageId,
    automationRunId: stringValue(context.automationRunId),
    automationId: stringValue(context.automationId),
    wakeupRequestId: run.wakeupRequestId ?? stringValue(context.wakeupRequestId),
  };
}

export function toAgentRuns(runs: HeartbeatRun[]): AgentRun[] {
  return runs.map(toAgentRun);
}

export function resolveAgentRunScene(run: HeartbeatRun): AgentRunScene {
  return toAgentRun(run).scene;
}
