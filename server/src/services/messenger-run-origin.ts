import type { Db } from "@rudderhq/db";
import {
  agentWakeupRequests,
  agents,
  automationRuns,
  automations,
  chatConversations,
  chatMessages,
  issues,
} from "@rudderhq/db";
import {
  toAgentRunOrigin,
  type Agent,
  type AgentRunOrigin,
  type MessengerRunOriginDescriptor,
  type MessengerThreadAction,
} from "@rudderhq/shared";
import { and, eq, inArray } from "drizzle-orm";

export interface MessengerFailedRunOriginRow {
  id: string;
  agentId: string;
  invocationSource: string;
  triggerDetail: string | null;
  wakeupRequestId: string | null;
  chatConversationId: string | null;
  contextSnapshot: Record<string, unknown> | null;
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function descriptorForOrigin(
  run: MessengerFailedRunOriginRow,
  origin: AgentRunOrigin,
  hydrated: {
    conversations: Map<string, { title: string }>;
    messages: Map<string, { conversationId: string }>;
    issues: Map<string, { identifier: string | null; title: string; status: string }>;
    automationRuns: Map<string, { automationId: string }>;
    automations: Map<string, { title: string; status: string }>;
    agents: Map<string, Pick<Agent, "id" | "name" | "icon" | "role" | "status" | "title">>;
    wakeupRequests: Map<string, { source: string; triggerDetail: string | null; reason: string | null }>;
  },
): MessengerRunOriginDescriptor {
  const base: MessengerRunOriginDescriptor = {
    runId: origin.runId,
    scene: origin.scene,
    targetType: origin.targetType,
    targetId: null,
    triggerKind: origin.triggerKind,
    invocationSource: origin.invocationSource,
    conversationId: null,
    messageId: null,
    issueId: null,
    automationRunId: null,
    automationId: null,
    wakeupRequestId: null,
    targetLabel: null,
    targetStatus: null,
    sourceState: "legacy_unknown",
    source: { kind: "unavailable", state: "legacy_unknown" },
  };

  const unavailable = (): MessengerRunOriginDescriptor => ({
    ...base,
    sourceState: "source_unavailable",
    source: { kind: "unavailable", state: "source_unavailable" },
  });

  if (origin.scene === "chat") {
    if (!origin.conversationId || !origin.messageId) return base;
    const conversation = hydrated.conversations.get(origin.conversationId);
    const message = hydrated.messages.get(origin.messageId);
    if (!conversation || message?.conversationId !== origin.conversationId) {
      return unavailable();
    }
    return {
      ...base,
      targetId: origin.targetType === "chat_conversation"
        ? origin.conversationId
        : origin.targetType === "chat_message" ? origin.messageId : null,
      conversationId: origin.conversationId,
      messageId: origin.messageId,
      targetLabel: conversation.title,
      sourceState: "available",
      source: {
        kind: "chat",
        title: conversation.title,
        href: `/messenger/chat/${origin.conversationId}?messageId=${encodeURIComponent(origin.messageId)}`,
      },
    };
  }

  if (origin.scene === "issue" || origin.scene === "review") {
    if (!origin.issueId) return base;
    const issue = hydrated.issues.get(origin.issueId);
    if (!issue) return unavailable();
    const issueRef = issue.identifier ?? origin.issueId;
    return {
      ...base,
      targetId: origin.targetType === "issue" ? origin.issueId : null,
      issueId: origin.issueId,
      targetLabel: issue.identifier ? `${issue.identifier} · ${issue.title}` : issue.title,
      targetStatus: issue.status,
      sourceState: "available",
      source: {
        kind: origin.scene,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        href: `/issues/${encodeURIComponent(issueRef)}`,
      },
    };
  }

  if (origin.scene === "automation") {
    if (!origin.automationRunId) return base;
    const automationRun = hydrated.automationRuns.get(origin.automationRunId);
    if (!automationRun) return unavailable();
    if (origin.automationId && origin.automationId !== automationRun.automationId) {
      return unavailable();
    }
    const automationId = origin.automationId ?? automationRun.automationId;
    const automation = hydrated.automations.get(automationId);
    if (!automation) return unavailable();
    return {
      ...base,
      targetId: origin.targetType === "automation_run" ? origin.automationRunId : null,
      automationRunId: origin.automationRunId,
      automationId,
      targetLabel: automation.title,
      targetStatus: automation.status,
      sourceState: "available",
      source: {
        kind: "automation",
        title: automation.title,
        status: automation.status,
        href: `/automations/${encodeURIComponent(automationId)}`,
      },
    };
  }

  const snapshot = run.contextSnapshot ?? {};
  const hasExplicitHeartbeatScene = snapshot.scene === "heartbeat" || snapshot.rudderScene === "heartbeat";
  const isTimer = run.invocationSource === "timer";
  const isManual = run.invocationSource === "on_demand"
    && (run.triggerDetail === "manual" || origin.triggerKind === "manual");
  if (!hasExplicitHeartbeatScene && !isTimer && !isManual) return base;
  if (!origin.wakeupRequestId) return base;
  const wakeupRequest = hydrated.wakeupRequests.get(origin.wakeupRequestId);
  const agent = hydrated.agents.get(run.agentId);
  if (!wakeupRequest || !agent) return unavailable();
  return {
    ...base,
    targetId: origin.targetType === "wakeup_request" ? origin.wakeupRequestId : null,
    wakeupRequestId: origin.wakeupRequestId,
    targetLabel: isTimer ? "Timer self-check" : isManual ? "Manual heartbeat" : "Heartbeat wakeup",
    sourceState: "available",
    source: {
      kind: "heartbeat",
      agent,
      href: `/agents/${encodeURIComponent(agent.id)}`,
    },
  };
}

/**
 * Hydrates only readable, organization-owned origin labels for failed-run cards.
 * Raw run snapshots stay server-side and target ids never bypass organization filters.
 */
export async function hydrateMessengerFailedRunOrigins(
  db: Db,
  orgId: string,
  runs: MessengerFailedRunOriginRow[],
) {
  const normalized = runs.map((run) => ({ run, origin: toAgentRunOrigin(run) }));
  const conversationIds = uniqueNonEmpty(normalized.map(({ origin }) => origin.conversationId));
  const messageIds = uniqueNonEmpty(normalized.map(({ origin }) => origin.messageId));
  const issueIds = uniqueNonEmpty(normalized.map(({ origin }) => origin.issueId));
  const automationRunIds = uniqueNonEmpty(normalized.map(({ origin }) => origin.automationRunId));
  const wakeupRequestIds = uniqueNonEmpty(normalized.map(({ origin }) => origin.wakeupRequestId));
  const agentIds = uniqueNonEmpty(runs.map((run) => run.agentId));

  const [conversationRows, messageRows, issueRows, automationRunRows, wakeupRequestRows, agentRows] = await Promise.all([
    conversationIds.length > 0
      ? db.select({ id: chatConversations.id, title: chatConversations.title })
        .from(chatConversations)
        .where(and(eq(chatConversations.orgId, orgId), inArray(chatConversations.id, conversationIds)))
      : Promise.resolve([]),
    messageIds.length > 0
      ? db.select({ id: chatMessages.id, conversationId: chatMessages.conversationId })
        .from(chatMessages)
        .where(and(eq(chatMessages.orgId, orgId), inArray(chatMessages.id, messageIds)))
      : Promise.resolve([]),
    issueIds.length > 0
      ? db.select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
      })
        .from(issues)
        .where(and(eq(issues.orgId, orgId), inArray(issues.id, issueIds)))
      : Promise.resolve([]),
    automationRunIds.length > 0
      ? db.select({ id: automationRuns.id, automationId: automationRuns.automationId })
        .from(automationRuns)
        .where(and(eq(automationRuns.orgId, orgId), inArray(automationRuns.id, automationRunIds)))
      : Promise.resolve([]),
    wakeupRequestIds.length > 0
      ? db.select({
        id: agentWakeupRequests.id,
        source: agentWakeupRequests.source,
        triggerDetail: agentWakeupRequests.triggerDetail,
        reason: agentWakeupRequests.reason,
      })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.orgId, orgId),
          inArray(agentWakeupRequests.id, wakeupRequestIds),
        ))
      : Promise.resolve([]),
    agentIds.length > 0
      ? db.select({
        id: agents.id,
        name: agents.name,
        icon: agents.icon,
        role: agents.role,
        status: agents.status,
        title: agents.title,
      })
        .from(agents)
        .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds)))
      : Promise.resolve([]),
  ]);

  const automationIds = uniqueNonEmpty([
    ...normalized.map(({ origin }) => origin.automationId),
    ...automationRunRows.map((row) => row.automationId),
  ]);
  const automationRows = automationIds.length > 0
    ? await db.select({ id: automations.id, title: automations.title, status: automations.status })
      .from(automations)
      .where(and(eq(automations.orgId, orgId), inArray(automations.id, automationIds)))
    : [];
  const hydrated = {
    conversations: new Map(conversationRows.map((row) => [row.id, { title: row.title }])),
    messages: new Map(messageRows.map((row) => [row.id, { conversationId: row.conversationId }])),
    issues: new Map(issueRows.map((row) => [row.id, {
      identifier: row.identifier,
      title: row.title,
      status: row.status,
    }])),
    automationRuns: new Map(automationRunRows.map((row) => [row.id, { automationId: row.automationId }])),
    automations: new Map(automationRows.map((row) => [row.id, { title: row.title, status: row.status }])),
    agents: new Map(agentRows.map((row) => [row.id, {
      id: row.id,
      name: row.name,
      icon: row.icon,
      role: row.role as Agent["role"],
      status: row.status as Agent["status"],
      title: row.title,
    }])),
    wakeupRequests: new Map(wakeupRequestRows.map((row) => [row.id, {
      source: row.source,
      triggerDetail: row.triggerDetail,
      reason: row.reason,
    }])),
  };

  return new Map(normalized.map(({ run, origin }) => [
    run.id,
    descriptorForOrigin(run, origin, hydrated),
  ]));
}

export function messengerFailedRunSourceAction(
  origin: MessengerRunOriginDescriptor,
): MessengerThreadAction | null {
  if (origin.source.kind === "unavailable") return null;
  const labels = {
    chat: "Open chat message",
    issue: "Open issue",
    review: "Open review",
    automation: "Open automation",
    heartbeat: "Open agent",
  } as const;
  return {
    label: labels[origin.source.kind],
    href: origin.source.href,
    method: "GET",
  };
}
