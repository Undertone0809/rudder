/**
 * Goal contract service.
 *
 * Reasoning:
 * - Contract/lifecycle changes are commands so a caller cannot silently turn
 *   a Goal into an achieved result by patching a legacy status column.
 * - Legacy hierarchy columns remain readable for existing issue/project links,
 *   but canonical Goals are top-level drafts with an explicit Owner and Plan.
 *
 * Traceability:
 * - doc/plans/2026-08-04-goal-system-refactor.md
 * - doc/product/domains/organizations-and-goals/goals-and-projects.md
 */
import type { Db } from "@rudderhq/db";
import {
  agentWakeupRequests,
  agents,
  approvals,
  assets,
  authUsers,
  automations,
  calendarEvents,
  costEvents,
  financeEvents,
  goalActivities,
  goalChangeProposals,
  goalFeedbackEntries,
  goalOwnerAssignments,
  goalPlans,
  goalResultProposals,
  goalStartRequests,
  goals,
  heartbeatRuns,
  issues,
  projectGoals,
  projects,
} from "@rudderhq/db";
import type {
  AcceptGoalResultProposal,
  ActivateGoal,
  AssignGoalOwner,
  CreateGoalActivity,
  CreateGoalChangeProposal,
  CreateGoalFeedback,
  CreateGoalResultProposal,
  DecideGoalChangeProposal,
  EvaluateGoal,
  GoalContractPatch,
  GoalContractSnapshot,
  GoalDependencies,
  GoalDependencyPreview,
  GoalEvaluationCandidate,
  GoalEvaluatorKind,
  GoalHistoryItem,
  GoalHistoryPage,
  GoalResultProposal,
  GoalResultReducerPreflight,
  GoalStartPacket,
  GoalStartPreview,
  PreviewGoalStart,
  RejectGoalResultProposal,
  StartGoal,
  UpdateGoalPlan,
} from "@rudderhq/shared";
import { activateGoalSchema } from "@rudderhq/shared";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { createHash, randomUUID } from "node:crypto";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { buildDeferredWakePayload, readDeferredWakePayload } from "./runtime-kernel/heartbeat.sessions.js";

type GoalRow = typeof goals.$inferSelect;
type GoalReader = Pick<Db, "select">;
type GoalWakeupActor = {
  actorType: "user" | "agent" | "system";
  actorId: string | null;
};
type GoalWakeupDispatch = {
  ownerAgentId: string;
  wakeupRequestId: string;
  source: "on_demand";
  triggerDetail: "system";
  reason: "goal_started" | "goal_feedback" | "goal_change_decided";
  payload: Record<string, unknown>;
  contextSnapshot: Record<string, unknown>;
  requestedByActorType: GoalWakeupActor["actorType"];
  requestedByActorId: string | null;
  idempotencyKey: string;
};
type GoalAgent = Pick<
  typeof agents.$inferSelect,
  "id" | "orgId" | "name" | "status" | "role" | "title" | "capabilities"
>;

const DEPENDENCY_PREVIEW_LIMIT = 5;
const GOAL_HISTORY_DEFAULT_LIMIT = 50;
const GOAL_HISTORY_MAX_LIMIT = 100;
const TERMINAL_RUN_STATUSES = ["succeeded", "completed", "failed", "cancelled", "timed_out"] as const;
const CURRENT_PROGRESS_ACTIVITY_KINDS = ["progress", "evidence", "checkpoint", "closeout"] as const;
const NON_INVOKABLE_AGENT_STATUSES = new Set(["terminated", "pending_approval"]);
const GOAL_OUTCOME_PATTERNS = [
  /\b(ship|publish|launch|deliver|creat(?:e|ed|ion)|build|complet(?:e|ed|ion)|finish|deploy|release|migrate|implement|fix|resolve|remove|establish|achieve|reach|increase|reduce|decrease|grow|choose|select|decide|approve|pass|verify|maintain|keep|sustain|recommend|submit)\b/i,
  /(?:发布|上线|交付|创建|构建|完成|部署|发版|迁移|实现|修复|解决|删除|建立|达到|提升|增加|降低|减少|增长|选择|决定|批准|通过|验证|保持|维持|产出|提交)/,
  /(?:\d+(?:\.\d+)?\s*(?:%|percent|x|倍|个|项|天|周|月|年))|(?:[$€£¥￥]\s*\d)/i,
];
const GOAL_MODE_PATTERNS = {
  decide: /\b(choose|select|decide|recommend|approve)\b|(?:选择|决定|推荐|批准)/i,
  maintain: /\b(maintain|keep|sustain|preserve|prevent)\b|(?:保持|维持|防止|确保持续)/i,
  maximize: /\b(increase|reduce|decrease|grow|improve by|maximi[sz]e|minimi[sz]e)\b|(?:提升|增加|降低|减少|增长|最大化|最小化)/i,
} as const;
const BROAD_CAPABILITY_PATTERNS = [
  /\b(general[- ]purpose|end[- ]to[- ]end)\b/i,
  /\bplan\w*\b[\s\S]*\bexecut\w*\b|\bexecut\w*\b[\s\S]*\bplan\w*\b/i,
  /(?:通用|端到端|规划[\s\S]*执行|执行[\s\S]*规划)/,
];
const CAPABILITY_STOP_WORDS = new Set([
  "about", "after", "agent", "and", "are", "available", "before", "bounded", "can", "context",
  "external", "first", "for", "from", "goal", "have", "into", "must", "not", "produce", "result",
  "should", "that", "the", "their", "this", "through", "user", "will", "with", "work",
]);

function hasConcreteGoalOutcome(input: PreviewGoalStart) {
  const combined = `${input.title.trim()} ${input.context?.trim() ?? ""}`;
  if (input.title.trim().length < 8) return false;
  if (GOAL_OUTCOME_PATTERNS.some((pattern) => pattern.test(combined))) return true;
  return meaningfulTokens(combined).size >= 4 || /[\p{Script=Han}]{6,}/u.test(combined);
}

function goalMode(input: PreviewGoalStart): "target" | "maximize" | "maintain" | "decide" {
  const title = input.title.trim();
  if (GOAL_MODE_PATTERNS.decide.test(title)) return "decide";
  if (GOAL_MODE_PATTERNS.maintain.test(title)) return "maintain";
  if (GOAL_MODE_PATTERNS.maximize.test(title)) return "maximize";
  if (GOAL_OUTCOME_PATTERNS.some((pattern) => pattern.test(title))) return "target";

  const context = input.context?.trim() ?? "";
  if (GOAL_MODE_PATTERNS.decide.test(context)) return "decide";
  if (GOAL_MODE_PATTERNS.maintain.test(context)) return "maintain";
  if (GOAL_MODE_PATTERNS.maximize.test(context)) return "maximize";
  return "target";
}

function meaningfulTokens(value: string) {
  return new Set((value.toLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]{2,}/gu) ?? [])
    .map((token) => token.replace(/(?:ing|ed|es|s)$/i, ""))
    .filter((token) => token.length >= 3 && !CAPABILITY_STOP_WORDS.has(token)));
}

function ownerCanAdvanceGoal(owner: GoalAgent, input: PreviewGoalStart) {
  const capabilities = owner.capabilities?.trim() ?? "";
  if (!capabilities) return false;
  const descriptor = [owner.role, owner.title, capabilities].filter(Boolean).join(" ");
  if (BROAD_CAPABILITY_PATTERNS.some((pattern) => pattern.test(descriptor))) return true;

  const goalTokens = meaningfulTokens(`${input.title} ${input.context ?? ""}`);
  const capabilityTokens = meaningfulTokens(descriptor);
  let overlappingTokenCount = 0;
  for (const token of goalTokens) {
    if (capabilityTokens.has(token)) overlappingTokenCount += 1;
  }
  if (overlappingTokenCount >= 2) return true;

  const domainPairs = [
    [/\b(api|app|build|code|deploy|engineer|implement|release|software|system|test|ui|workspace)\b|(?:代码|工程|开发|部署|测试|系统|界面)/i, /\b(engineer|software|code|develop|build|deploy|test|technical|product)\b|(?:工程|开发|代码|部署|测试|技术|产品)/i],
    [/\b(analy[sz]e|research|study|report|investigate)\b|(?:分析|研究|调研|报告)/i, /\b(analyst|analysis|research|data|strategy)\b|(?:分析|研究|数据|策略)/i],
    [/\b(article|content|copy|marketing|publish|write)\b|(?:文章|内容|文案|营销|发布|写作)/i, /\b(content|copy|marketing|publish|writer|writing)\b|(?:内容|文案|营销|发布|写作)/i],
    [/\b(design|ux|ui|prototype)\b|(?:设计|原型|界面)/i, /\b(design|designer|ux|ui|product)\b|(?:设计|产品|界面)/i],
    [/\b(budget|finance|invoice|pricing|revenue)\b|(?:预算|财务|发票|定价|收入)/i, /\b(finance|financial|invoice|pricing|revenue|accounting)\b|(?:财务|发票|定价|收入|会计)/i],
  ] as const;
  const goalText = `${input.title} ${input.context ?? ""}`;
  return domainPairs.some(([goalPattern, capabilityPattern]) => goalPattern.test(goalText) && capabilityPattern.test(descriptor));
}

function canonicalizeJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalizeJson(entry)]));
}

export function stableGoalHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalizeJson(value))).digest("hex");
}

function stringEvidenceRefs(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

type ExternalGoalWorkFact = {
  id: string;
  kind: "work_status";
  summary: string;
  occurredAt: Date;
  sourceId: string;
  sourceRunId: string | null;
  runStatus: string | null;
  evidenceRefs: string[];
};

const GOAL_HISTORY_KINDS = ["activity", "feedback", "change_proposal", "result_proposal"] as const;
type GoalHistoryKind = (typeof GOAL_HISTORY_KINDS)[number];
type GoalHistoryCursor = { version: 1; createdAt: string; kind: GoalHistoryKind; id: string };

function encodeGoalHistoryCursor(item: GoalHistoryItem) {
  const createdAt = item.createdAt instanceof Date ? item.createdAt.toISOString() : new Date(item.createdAt).toISOString();
  return Buffer.from(JSON.stringify({ version: 1, createdAt, kind: item.kind, id: item.id } satisfies GoalHistoryCursor))
    .toString("base64url");
}

function decodeGoalHistoryCursor(value: string | null | undefined): GoalHistoryCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<GoalHistoryCursor>;
    if (parsed.version !== 1
      || typeof parsed.createdAt !== "string"
      || Number.isNaN(new Date(parsed.createdAt).getTime())
      || !GOAL_HISTORY_KINDS.includes(parsed.kind as GoalHistoryKind)
      || typeof parsed.id !== "string"
      || !parsed.id) {
      throw new Error("invalid cursor payload");
    }
    return parsed as GoalHistoryCursor;
  } catch {
    throw badRequest("Invalid Goal history cursor");
  }
}

function historyCursorCondition(
  timestampColumn: AnyPgColumn,
  idColumn: AnyPgColumn,
  kind: GoalHistoryKind,
  cursor: GoalHistoryCursor | null,
) {
  if (!cursor) return undefined;
  const cursorDate = new Date(cursor.createdAt);
  const kindOrder = kind.localeCompare(cursor.kind);
  if (kindOrder > 0) return or(lt(timestampColumn, cursorDate), eq(timestampColumn, cursorDate));
  if (kindOrder < 0) return lt(timestampColumn, cursorDate);
  return or(
    lt(timestampColumn, cursorDate),
    and(eq(timestampColumn, cursorDate), gt(idColumn, cursor.id)),
  );
}

function publicGoalOutcome(outcome: string) {
  if (outcome === "achieved") return "Goal achieved";
  if (outcome === "not_achieved") return "Goal not achieved";
  if (outcome === "maintained") return "Goal maintained";
  if (outcome === "breached") return "Goal condition breached";
  if (outcome === "completed_with_result") return "Goal completed with a measured result";
  if (outcome === "decided") return "Goal completed with a decision";
  return "Result needs more evidence";
}

function publicGoalActivitySummary(
  activity: Pick<typeof goalActivities.$inferSelect, "activityKind" | "summary">,
) {
  if (activity.activityKind !== "closeout") return activity.summary;
  const legacyOutcome = /^Goal evaluated as\s+(.+)$/i.exec(activity.summary)?.[1]?.trim();
  return legacyOutcome ? publicGoalOutcome(legacyOutcome) : activity.summary;
}

function resultSummary(run: {
  status: string;
  resultJson: Record<string, unknown> | null;
  resultSummaryJson: Record<string, unknown> | null;
  error: string | null;
}) {
  const candidates = [run.resultSummaryJson, run.resultJson];
  for (const candidate of candidates) {
    for (const key of ["summary", "result", "message", "userMessage", "body", "error"]) {
      const value = candidate?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return run.error?.trim() || `Agent run is ${run.status}.`;
}

function sameHashPayload(left: unknown, right: unknown) {
  return stableGoalHash(left) === stableGoalHash(right);
}

function toIsoString(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function goalContractSnapshot(goal: GoalRow): GoalContractSnapshot {
  return {
    contractRevision: goal.contractRevision,
    outcomeStatement: goal.outcomeStatement ?? "",
    objectiveMode: goal.objectiveMode as GoalContractSnapshot["objectiveMode"],
    criteria: goal.criteria as GoalContractSnapshot["criteria"],
    autonomyEnvelope: goal.autonomyEnvelope,
    humanAuthorities: goal.humanAuthorities,
    evaluationPolicy: goal.evaluationPolicy,
    actionDeadline: toIsoString(goal.actionDeadline),
    evaluationDeadline: toIsoString(goal.evaluationDeadline),
  };
}

function normalizeContractPatch(patch: CreateGoalChangeProposal["afterContract"]): GoalContractPatch {
  return {
    ...patch,
    ...(patch.actionDeadline !== undefined ? { actionDeadline: toIsoString(patch.actionDeadline) } : {}),
    ...(patch.evaluationDeadline !== undefined ? { evaluationDeadline: toIsoString(patch.evaluationDeadline) } : {}),
  } as GoalContractPatch;
}

function countRows(rows: Array<{ count: unknown }>) {
  return Number(rows[0]?.count ?? 0);
}

function previewRows<T>(rows: T[], map: (row: T) => GoalDependencyPreview) {
  return rows.slice(0, DEPENDENCY_PREVIEW_LIMIT).map(map);
}

function assertCanonicalActiveGoal(goal: Pick<GoalRow, "lifecycle" | "ownerAgentId" | "outcomeStatement" | "criteria" | "planRevision" | "continuationKind" | "continuationSummary">) {
  if (goal.lifecycle !== "active") throw conflict("Only active Goals can receive this command");
  if (!goal.ownerAgentId || !goal.outcomeStatement?.trim() || !Array.isArray(goal.criteria) || goal.criteria.length === 0
    || goal.planRevision < 1 || !goal.continuationKind || !goal.continuationSummary?.trim()) {
    throw conflict("Goal requires Contract activation before this command");
  }
}

function assertGoalOwner(goal: Pick<GoalRow, "ownerAgentId">, actorAgentId: string | null) {
  if (actorAgentId && actorAgentId !== goal.ownerAgentId) {
    throw forbidden("Only the Goal Owner can perform this Agent command");
  }
}

async function requireInvokableOwner(db: GoalReader, orgId: string, ownerAgentId: string) {
  const owner = await db
    .select({
      id: agents.id,
      orgId: agents.orgId,
      name: agents.name,
      status: agents.status,
      role: agents.role,
      title: agents.title,
      capabilities: agents.capabilities,
    })
    .from(agents)
    .where(and(eq(agents.id, ownerAgentId), eq(agents.orgId, orgId)))
    .then((rows) => rows[0] ?? null);
  if (!owner) throw unprocessable("Goal owner must belong to the same organization");
  if (NON_INVOKABLE_AGENT_STATUSES.has(owner.status)) {
    throw unprocessable("Goal owner must be invokable", { status: owner.status });
  }
  return owner as GoalAgent;
}

export function compileGoalStartPreview(
  input: PreviewGoalStart,
  owner: GoalAgent | null,
): GoalStartPreview {
  const title = input.title.trim();
  if (!hasConcreteGoalOutcome(input)) {
    return {
      valid: false,
      packetHash: null,
      packet: null,
      review: null,
      alignmentQuestion: "What observable result or decision should this Goal produce, and how will we know it worked?",
      warning: null,
    };
  }
  if (!owner || owner.id !== input.ownerAgentId || NON_INVOKABLE_AGENT_STATUSES.has(owner.status)) {
    return {
      valid: false,
      packetHash: null,
      packet: null,
      review: null,
      alignmentQuestion: "Which available same-organization Agent should own and advance this Goal?",
      warning: null,
    };
  }
  const warning = ownerCanAdvanceGoal(owner, input)
    ? null
    : "This Agent may not be the best match for this Goal. You selected this Agent, so you can still start it or choose another Agent.";

  const mode = goalMode(input);
  const context = input.context?.trim() || null;
  const success = context
    ? `Evidence demonstrates that ${title} while satisfying: ${context}`
    : mode === "decide"
      ? `A documented decision resolves: ${title}`
      : mode === "maximize"
        ? `Measured evidence demonstrates progress toward: ${title}`
        : mode === "maintain"
          ? `Evidence confirms the condition remained true: ${title}`
          : `An inspectable artifact demonstrates that ${title}`;
  const firstAction = mode === "decide"
    ? "Gather the decision inputs and return with a clear recommendation and tradeoffs."
    : mode === "maximize"
      ? "Establish the current baseline and take the first measurable action."
      : mode === "maintain"
        ? "Confirm the current baseline and monitor the first material risk."
        : "Inspect the available context and produce the first bounded, reviewable artifact.";
  const evaluator = mode === "decide" ? "human" : mode === "maximize" ? "metric" : mode === "maintain" ? "policy" : "artifact";
  const boundary = "The Owner may perform bounded, reversible work; consequential or irreversible actions require human approval.";
  const activation = activateGoalSchema.parse({
      confirmed: true,
      ownerAgentId: owner.id,
      outcomeStatement: title,
      objectiveMode: mode,
      criteria: [{ id: "primary-outcome", label: success, evaluator }],
      autonomyEnvelope: {
        allowed: ["bounded_reversible_work"],
        requiresHumanApproval: ["external_or_irreversible_action", "authority_expansion"],
      },
      humanAuthorities: {
        acceptance: "board_human",
        consequentialChanges: "board_human",
      },
      evaluationPolicy: {
        terminalEvidenceRequired: true,
        humanAcceptanceRequired: true,
      },
      actionDeadline: null,
      evaluationDeadline: input.targetTime,
      initialPlan: { summary: firstAction },
      initialContinuation: {
        kind: "commitment",
        summary: "Advance the first bounded action and report evidence or a named blocker.",
      },
  });
  const packet: GoalStartPacket = {
    version: 1,
    title,
    description: context,
    ownerAgentId: owner.id,
    activation,
  };
  return {
    valid: true,
    packetHash: stableGoalHash(packet),
    packet,
    review: {
      outcome: title,
      success,
      boundary,
      firstAction,
      ownerAgentId: owner.id,
      targetTime: input.targetTime,
    },
    alignmentQuestion: null,
    warning,
  };
}

export async function getGoalDependencies(db: Db, goal: GoalRow): Promise<GoalDependencies> {
  const [childGoalRows, projectJoinRows, legacyProjectRows, issueRows, automationRows, calendarEventRows, costEventRows, financeEventRows] = await Promise.all([
    db.select({ id: goals.id, title: goals.title, status: goals.status }).from(goals)
      .where(and(eq(goals.orgId, goal.orgId), eq(goals.parentId, goal.id))).orderBy(asc(goals.createdAt)),
    db.select({ id: projects.id, name: projects.name, status: projects.status }).from(projectGoals)
      .innerJoin(projects, eq(projectGoals.projectId, projects.id))
      .where(and(eq(projectGoals.orgId, goal.orgId), eq(projectGoals.goalId, goal.id))).orderBy(asc(projects.createdAt)),
    db.select({ id: projects.id, name: projects.name, status: projects.status }).from(projects)
      .where(and(eq(projects.orgId, goal.orgId), eq(projects.goalId, goal.id))).orderBy(asc(projects.createdAt)),
    db.select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status }).from(issues)
      .where(and(eq(issues.orgId, goal.orgId), eq(issues.goalId, goal.id))).orderBy(asc(issues.createdAt)),
    db.select({ id: automations.id, title: automations.title, status: automations.status }).from(automations)
      .where(and(eq(automations.orgId, goal.orgId), eq(automations.goalId, goal.id))).orderBy(asc(automations.createdAt)),
    db.select({ id: calendarEvents.id, title: calendarEvents.title, status: calendarEvents.eventStatus }).from(calendarEvents)
      .where(and(eq(calendarEvents.orgId, goal.orgId), eq(calendarEvents.goalId, goal.id), isNull(calendarEvents.deletedAt)))
      .orderBy(asc(calendarEvents.createdAt)),
    db.select({ count: sql<number>`count(*)::int` }).from(costEvents)
      .where(and(eq(costEvents.orgId, goal.orgId), eq(costEvents.goalId, goal.id))),
    db.select({ count: sql<number>`count(*)::int` }).from(financeEvents)
      .where(and(eq(financeEvents.orgId, goal.orgId), eq(financeEvents.goalId, goal.id))),
  ]);

  const linkedProjectsById = new Map<string, (typeof projectJoinRows)[number]>();
  for (const project of [...projectJoinRows, ...legacyProjectRows]) linkedProjectsById.set(project.id, project);
  const linkedProjects = [...linkedProjectsById.values()];
  const counts = {
    childGoals: childGoalRows.length,
    linkedProjects: linkedProjects.length,
    linkedIssues: issueRows.length,
    automations: automationRows.length,
    calendarEvents: calendarEventRows.length,
    costEvents: countRows(costEventRows),
    financeEvents: countRows(financeEventRows),
  };
  const blockers = [
    ...(counts.childGoals > 0 ? ["child_goals"] : []),
    ...(counts.linkedProjects > 0 ? ["linked_projects"] : []),
    ...(counts.linkedIssues > 0 ? ["linked_issues"] : []),
    ...(counts.automations > 0 ? ["automations"] : []),
    ...(counts.calendarEvents > 0 ? ["calendar_events"] : []),
    ...(counts.costEvents > 0 ? ["cost_events"] : []),
    ...(counts.financeEvents > 0 ? ["finance_events"] : []),
  ];
  return {
    goalId: goal.id,
    orgId: goal.orgId,
    canDelete: blockers.length === 0 && goal.lifecycle === "draft",
    blockers: goal.lifecycle === "draft" ? blockers : [...blockers, "goal_not_draft"],
    isLastRootOrganizationGoal: false,
    counts,
    previews: {
      childGoals: previewRows(childGoalRows, (row) => ({ id: row.id, title: row.title, subtitle: row.status })),
      linkedProjects: previewRows(linkedProjects, (row) => ({ id: row.id, title: row.name, subtitle: row.status })),
      linkedIssues: previewRows(issueRows, (row) => ({ id: row.id, title: row.title, subtitle: row.identifier ?? row.status })),
      automations: previewRows(automationRows, (row) => ({ id: row.id, title: row.title, subtitle: row.status })),
      calendarEvents: previewRows(calendarEventRows, (row) => ({ id: row.id, title: row.title, subtitle: row.status })),
    },
  };
}

async function requireGoal(db: GoalReader, id: string) {
  const goal = await db.select().from(goals).where(eq(goals.id, id)).then((rows) => rows[0] ?? null);
  if (!goal) throw notFound("Goal not found");
  return goal;
}

async function requireGoalForUpdate(db: GoalReader, id: string) {
  const goal = await db.select().from(goals).where(eq(goals.id, id))
    .for("update").then((rows) => rows[0] ?? null);
  if (!goal) throw notFound("Goal not found");
  return goal;
}

function positiveOutcome(mode: string, outcome: string) {
  return (mode === "target" && outcome === "achieved")
    || (mode === "maximize" && outcome === "completed_with_result")
    || (mode === "maintain" && outcome === "maintained")
    || (mode === "decide" && outcome === "decided");
}

export function reduceGoalEvaluation(goal: Pick<GoalRow, "objectiveMode" | "criteria">, input: EvaluateGoal) {
  const statuses = new Map(input.criteria.map((criterion) => [criterion.id, criterion.status]));
  const evidenceRefs = input.evidenceRefs;
  const hasReference = (reference: string) => evidenceRefs.some((evidence) => evidence === reference);
  const criterionStatuses = (goal.criteria as Array<{
    id: string;
    evaluator?: GoalEvaluatorKind;
    evidenceRequirements?: string[];
  }>).map((criterion) => {
    const requiredEvidence = criterion.evidenceRequirements ?? [];
    const missingEvidence = requiredEvidence.filter((reference) => !hasReference(reference));
    const evaluatorEvidenceSatisfied = criterion.evaluator === "metric"
      ? input.resultValue !== undefined
      : criterion.evaluator === "human"
        ? Boolean(input.decision?.trim() || input.resultPayload.humanApproval === true)
        : evidenceRefs.length > 0;
    const evidenceSatisfied = missingEvidence.length === 0 && evaluatorEvidenceSatisfied;
    const submittedStatus = statuses.get(criterion.id) ?? "unknown";
    return {
      id: criterion.id,
      evaluator: criterion.evaluator ?? null,
      status: !evidenceSatisfied ? "unknown" : submittedStatus,
      evidenceSatisfied,
      missingEvidence,
    };
  });
  const has = (status: string) => criterionStatuses.some((criterion) => criterion.status === status);
  const allMet = criterionStatuses.length > 0 && criterionStatuses.every((criterion) => criterion.status === "met");
  const hasFailure = has("unmet") || has("breached");
  let outcome: string;
  switch (goal.objectiveMode) {
    case "target":
      outcome = hasFailure ? "not_achieved" : allMet ? "achieved" : "inconclusive";
      break;
    case "maximize":
      outcome = !hasFailure && allMet && input.resultValue !== undefined ? "completed_with_result" : "inconclusive";
      break;
    case "maintain":
      outcome = has("breached") ? "breached" : allMet ? "maintained" : "inconclusive";
      break;
    case "decide":
      outcome = !hasFailure && allMet && input.decision?.trim() ? "decided" : "inconclusive";
      break;
    default:
      outcome = "inconclusive";
  }
  return {
    mode: goal.objectiveMode as GoalResultProposal["preflight"]["mode"],
    outcome,
    criteria: criterionStatuses,
    evidenceRefs: input.evidenceRefs,
    resultValue: input.resultValue,
    decision: input.decision ?? null,
    evaluatedAt: new Date().toISOString(),
  };
}

function evaluationCandidate(input: EvaluateGoal | CreateGoalResultProposal): GoalEvaluationCandidate {
  return {
    evidenceRefs: input.evidenceRefs,
    criteria: input.criteria,
    ...(input.resultValue !== undefined ? { resultValue: input.resultValue } : {}),
    ...(input.decision !== undefined ? { decision: input.decision } : {}),
    resultPayload: input.resultPayload,
  };
}

function isTerminalEvaluation(outcome: string) {
  return outcome !== "inconclusive";
}

function inconclusiveResultSummary(preflight: GoalResultReducerPreflight, riskSummary: string) {
  const gaps = preflight.criteria.flatMap((criterion) => {
    if (criterion.missingEvidence.length > 0) {
      return criterion.missingEvidence.map((requirement) => `${criterion.id}: missing ${requirement}`);
    }
    return criterion.status === "unknown" ? [`${criterion.id}: unknown`] : [];
  });
  const details = [
    preflight.resultValue !== undefined ? `Result value: ${String(preflight.resultValue)}.` : null,
    preflight.decision ? `Decision: ${preflight.decision}.` : null,
    gaps.length > 0 ? `Gaps: ${gaps.join("; ")}.` : null,
  ].filter((value): value is string => Boolean(value));
  return [`Result attempt remains inconclusive: ${riskSummary}`, ...details].join(" ");
}

function proposalCreationPayload(input: CreateGoalChangeProposal, normalizedPatch: GoalContractPatch) {
  return {
    expectedContractRevision: input.expectedContractRevision,
    afterContract: normalizedPatch,
    rationale: input.rationale,
    evidenceRefs: input.evidenceRefs,
    approvalId: input.approvalId ?? null,
  };
}

function assertSameChangeProposalPayload(
  existing: typeof goalChangeProposals.$inferSelect,
  input: CreateGoalChangeProposal,
  normalizedPatch: GoalContractPatch,
) {
  if (input.approvalId && existing.approvalId !== input.approvalId) {
    throw conflict("Goal change proposal idempotency key was reused with a different approval");
  }
  const stored = {
    expectedContractRevision: existing.expectedContractRevision,
    afterContract: existing.afterContract,
    rationale: existing.rationale,
    evidenceRefs: existing.evidenceRefs,
    approvalId: input.approvalId ?? null,
  };
  if (!sameHashPayload(stored, proposalCreationPayload(input, normalizedPatch))) {
    throw conflict("Goal change proposal idempotency key was reused with a different payload");
  }
}

function assertSameResultProposalPayload(
  existing: typeof goalResultProposals.$inferSelect,
  input: CreateGoalResultProposal,
  candidateHash: string,
) {
  if (existing.contractRevision !== input.contractRevision
    || existing.candidateHash !== candidateHash
    || existing.riskSummary !== input.riskSummary) {
    throw conflict("Goal result proposal idempotency key was reused with a different payload");
  }
}

export function goalService(db: Db) {
  type Database = typeof db;

  function facetFor(
    goal: GoalRow,
    pendingChange: typeof goalChangeProposals.$inferSelect | null,
    readyResult: typeof goalResultProposals.$inferSelect | null,
    pendingWakeup: Pick<typeof agentWakeupRequests.$inferSelect, "status"> | null = null,
  ) {
    if (goal.lifecycle === "closed") return "closed" as const;
    if (goal.lifecycle === "draft") return "needs_attention" as const;
    if (readyResult) return "ready_for_acceptance" as const;
    if (pendingChange) return "needs_attention" as const;
    if (pendingWakeup?.status === "deferred_goal_focus") return "waiting_focus" as const;
    if (pendingWakeup?.status === "deferred_goal_blocked"
      || pendingWakeup?.status === "deferred_agent_paused") return "needs_attention" as const;
    if (goal.continuationKind === "wait") return "waiting_external" as const;
    return "agent_advancing" as const;
  }

  function goalWakeupAttentionReason(
    wakeup: Pick<typeof agentWakeupRequests.$inferSelect, "status" | "error"> | null,
  ) {
    if (wakeup?.status === "deferred_agent_paused") {
      return "The Owner Agent is paused. Resume it to continue this Goal.";
    }
    if (wakeup?.status !== "deferred_goal_blocked") return null;
    if (wakeup.error === "heartbeat.wakeOnDemand.disabled") {
      return "The Owner Agent is not accepting on-demand work. Update the Agent or choose another Owner.";
    }
    if (wakeup.error === "agent.unavailable") {
      return "The Owner Agent is unavailable. Make it available or choose another Owner.";
    }
    if (wakeup.error === "budget.blocked") {
      return "The Owner Agent is blocked by a budget limit. Resolve the budget decision to continue.";
    }
    return "The Owner Agent cannot start this work yet. Resolve its blocking condition to continue.";
  }

  function pendingGoalWakeup(goal: Pick<GoalRow, "id" | "orgId">) {
    return db.select({
      status: agentWakeupRequests.status,
      error: agentWakeupRequests.error,
    }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.orgId, goal.orgId),
      sql`${agentWakeupRequests.payload} ->> 'goalId' = ${goal.id}`,
      inArray(agentWakeupRequests.status, [
        "deferred_goal_focus",
        "deferred_goal_blocked",
        "deferred_agent_paused",
      ]),
      isNull(agentWakeupRequests.runId),
    )).orderBy(desc(agentWakeupRequests.requestedAt)).limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function ensureGoalWakeupIntent(
    database: Database,
    goal: GoalRow,
    input: {
      event: "goal_started" | "goal_feedback" | "goal_change_decided";
      eventId: string;
      actor: GoalWakeupActor;
      feedback?: { id: string; body: string; kind: string };
      decision?: { decision: "approve" | "reject"; note: string | null; status: string };
    },
  ): Promise<GoalWakeupDispatch> {
    if (!goal.ownerAgentId) throw conflict("Goal has no Owner Agent to wake");
    const taskKey = `goal:${goal.id}:${input.event}:${input.eventId}`;
    const idempotencyKey = input.event === "goal_started"
      ? `goal-start:${input.eventId}`
      : input.event === "goal_feedback"
        ? `goal-feedback:${input.eventId}`
        : `goal-change-decision:${input.eventId}:${input.decision?.decision ?? "unknown"}`;
    const payload: Record<string, unknown> = {
      event: input.event,
      goalId: goal.id,
      taskKey,
      ...(input.event === "goal_started" ? { goalStartRequestId: input.eventId } : {}),
      ...(input.feedback ? { feedbackId: input.feedback.id } : {}),
      ...(input.decision ? { goalChangeProposalId: input.eventId, decision: input.decision.decision } : {}),
    };
    const contextSnapshot: Record<string, unknown> = {
      goalId: goal.id,
      taskKey,
      goal: {
        id: goal.id,
        title: goal.title,
        description: goal.description,
        outcomeStatement: goal.outcomeStatement,
        objectiveMode: goal.objectiveMode,
        contractRevision: goal.contractRevision,
        criteria: goal.criteria,
        autonomyEnvelope: goal.autonomyEnvelope,
        humanAuthorities: goal.humanAuthorities,
        evaluationPolicy: goal.evaluationPolicy,
        actionDeadline: goal.actionDeadline,
        evaluationDeadline: goal.evaluationDeadline,
      },
      goalContinuation: {
        kind: goal.continuationKind,
        summary: goal.continuationSummary,
        wakeCondition: goal.wakeCondition,
      },
      ...(input.feedback ? {
        goalFeedback: {
          id: input.feedback.id,
          body: input.feedback.body,
          kind: input.feedback.kind,
        },
      } : {}),
      ...(input.decision ? {
        goalDecision: {
          proposalId: input.eventId,
          decision: input.decision.decision,
          note: input.decision.note,
          status: input.decision.status,
        },
      } : {}),
    };
    const storedPayload = buildDeferredWakePayload(payload, contextSnapshot);
    const [inserted] = await database.insert(agentWakeupRequests).values({
      orgId: goal.orgId,
      agentId: goal.ownerAgentId,
      source: "on_demand",
      triggerDetail: "system",
      reason: input.event,
      payload: storedPayload,
      status: "queued",
      requestedByActorType: input.actor.actorType,
      requestedByActorId: input.actor.actorId,
      idempotencyKey,
    }).onConflictDoNothing().returning();
    const wakeup = inserted ?? await database.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.orgId, goal.orgId),
      eq(agentWakeupRequests.agentId, goal.ownerAgentId),
      eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
    )).then((rows) => rows[0] ?? null);
    if (!wakeup) throw conflict("Goal Owner wakeup could not be queued");
    if (!sameHashPayload(readDeferredWakePayload(wakeup.payload), payload)) {
      throw conflict("Goal Owner wakeup key was reused with a different payload");
    }
    const requestedByActorType = wakeup.requestedByActorType === "user"
      || wakeup.requestedByActorType === "agent"
      || wakeup.requestedByActorType === "system"
      ? wakeup.requestedByActorType
      : "system";
    return {
      ownerAgentId: goal.ownerAgentId,
      wakeupRequestId: wakeup.id,
      source: "on_demand",
      triggerDetail: "system",
      reason: input.event,
      payload,
      contextSnapshot,
      requestedByActorType,
      requestedByActorId: wakeup.requestedByActorId,
      idempotencyKey,
    };
  }

  async function latestExternalWorkFact(
    goal: GoalRow,
    preferredRunId: string | null = null,
  ): Promise<ExternalGoalWorkFact | null> {
    const [issueFacts, linkedProjectFacts, directRunFacts] = await Promise.all([
      db.select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        updatedAt: issues.updatedAt,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      }).from(issues).where(and(
        eq(issues.orgId, goal.orgId),
        eq(issues.goalId, goal.id),
      )),
      db.select({
        id: projects.id,
        name: projects.name,
        status: projects.status,
        updatedAt: projects.updatedAt,
      }).from(projects).leftJoin(
        projectGoals,
        and(eq(projectGoals.projectId, projects.id), eq(projectGoals.orgId, goal.orgId)),
      ).where(and(
        eq(projects.orgId, goal.orgId),
        or(eq(projects.goalId, goal.id), eq(projectGoals.goalId, goal.id)),
      )),
      goal.ownerAgentId
        ? db.select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          updatedAt: heartbeatRuns.updatedAt,
          resultJson: heartbeatRuns.resultJson,
          resultSummaryJson: heartbeatRuns.resultSummaryJson,
          error: heartbeatRuns.error,
        }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.orgId, goal.orgId),
          eq(heartbeatRuns.agentId, goal.ownerAgentId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'goalId' = ${goal.id}`,
        ))
        : Promise.resolve([]),
    ]);
    const runIds = [...new Set(issueFacts.flatMap((issue) => [issue.checkoutRunId, issue.executionRunId]).filter((id): id is string => Boolean(id)))];
    const runFacts = runIds.length > 0
      ? await db.select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        updatedAt: heartbeatRuns.updatedAt,
        resultJson: heartbeatRuns.resultJson,
        resultSummaryJson: heartbeatRuns.resultSummaryJson,
        error: heartbeatRuns.error,
      }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.orgId, goal.orgId),
        inArray(heartbeatRuns.id, runIds),
      ))
      : [];
    const relatedFacts: ExternalGoalWorkFact[] = [
      ...issueFacts.map((issue) => ({
        id: `work-status:issue:${issue.id}`,
        kind: "work_status" as const,
        summary: `Issue ${issue.identifier ?? issue.title} is ${issue.status}.`,
        occurredAt: issue.updatedAt,
        sourceId: issue.id,
        sourceRunId: issue.executionRunId ?? issue.checkoutRunId,
        runStatus: null,
        evidenceRefs: [],
      })),
      ...linkedProjectFacts.map((project) => ({
        id: `work-status:project:${project.id}`,
        kind: "work_status" as const,
        summary: `Project ${project.name} is ${project.status}.`,
        occurredAt: project.updatedAt,
        sourceId: project.id,
        sourceRunId: null,
        runStatus: null,
        evidenceRefs: [],
      })),
      ...runFacts.map((run) => ({
        id: `work-status:run:${run.id}`,
        kind: "work_status" as const,
        summary: `Agent run ${run.id.slice(0, 8)} is ${run.status}: ${resultSummary(run)}`,
        occurredAt: run.updatedAt,
        sourceId: run.id,
        sourceRunId: run.id,
        runStatus: run.status,
        evidenceRefs: [],
      })),
    ];
    const directFacts: ExternalGoalWorkFact[] = directRunFacts
      .filter((run) => !runFacts.some((linkedRun) => linkedRun.id === run.id))
      .map((run) => ({
        id: `work-status:run:${run.id}`,
        kind: "work_status" as const,
        summary: `Agent run ${run.id.slice(0, 8)} is ${run.status}: ${resultSummary(run)}`,
        occurredAt: run.updatedAt,
        sourceId: run.id,
        sourceRunId: run.id,
        runStatus: run.status,
        evidenceRefs: [],
      }));
    const allRunFacts = [...relatedFacts, ...directFacts].filter((fact) => fact.sourceId === fact.sourceRunId);
    const activeRunFacts = allRunFacts.filter((fact) => fact.runStatus && !TERMINAL_RUN_STATUSES.includes(fact.runStatus as typeof TERMINAL_RUN_STATUSES[number]));
    if (activeRunFacts.length > 0) {
      return activeRunFacts.sort((left, right) => {
        const timeDelta = right.occurredAt.getTime() - left.occurredAt.getTime();
        return timeDelta !== 0 ? timeDelta : right.id.localeCompare(left.id);
      })[0] ?? null;
    }
    const preferredRun = preferredRunId
      ? allRunFacts.find((fact) => fact.sourceRunId === preferredRunId) ?? null
      : null;
    if (preferredRun) return preferredRun;
    const facts = relatedFacts.length > 0 ? relatedFacts : directFacts;
    return facts.sort((left, right) => {
      const timeDelta = right.occurredAt.getTime() - left.occurredAt.getTime();
      return timeDelta !== 0 ? timeDelta : right.id.localeCompare(left.id);
    })[0] ?? null;
  }

  async function requireGoalRun(
    database: Database,
    goal: GoalRow,
    runId: string,
    actorAgentId: string | null = null,
  ) {
    const run = await database.select({
      id: heartbeatRuns.id,
      orgId: heartbeatRuns.orgId,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
    if (!run || run.orgId !== goal.orgId) {
      throw unprocessable("Goal Activity run must belong to the same organization");
    }
    if (actorAgentId && run.agentId !== actorAgentId) {
      throw unprocessable("Goal Activity run must belong to the acting Agent");
    }
    const context = run.contextSnapshot ?? {};
    if (context.goalId === goal.id) return run;
    const issueId = typeof context.issueId === "string" ? context.issueId : null;
    const linkedIssue = issueId
      ? await database.select({ goalId: issues.goalId }).from(issues).where(and(
        eq(issues.id, issueId),
        eq(issues.orgId, goal.orgId),
      )).then((rows) => rows[0] ?? null)
      : null;
    if (linkedIssue?.goalId === goal.id) return run;
    throw unprocessable("Goal Activity run must be linked to this Goal");
  }

  async function recordFeedback(
    database: Database,
    goal: GoalRow,
    input: CreateGoalFeedback,
    actorUserId: string,
  ) {
    assertCanonicalActiveGoal(goal);
    const contentHash = stableGoalHash({
      actorType: "user",
      actorId: actorUserId,
      body: input.body,
      attachments: input.attachments,
      feedbackKind: input.feedbackKind,
    });
    const existing = await database.select().from(goalFeedbackEntries).where(and(
      eq(goalFeedbackEntries.goalId, goal.id),
      eq(goalFeedbackEntries.idempotencyKey, input.idempotencyKey),
    )).then((rows) => rows[0] ?? null);
    if (existing) {
      if (existing.contentHash !== contentHash) {
        throw conflict("Goal feedback idempotency key was reused with a different payload");
      }
    }

    const [inserted] = existing ? [] : await database.insert(goalFeedbackEntries).values({
        orgId: goal.orgId,
        goalId: goal.id,
        actorType: "user",
        actorId: actorUserId,
        body: input.body,
        attachments: input.attachments,
        contentHash,
        feedbackKind: input.feedbackKind,
        idempotencyKey: input.idempotencyKey,
      }).onConflictDoNothing().returning();
    const feedback = existing ?? inserted ?? await database.select().from(goalFeedbackEntries).where(and(
        eq(goalFeedbackEntries.goalId, goal.id),
        eq(goalFeedbackEntries.idempotencyKey, input.idempotencyKey),
      )).then((rows) => rows[0] ?? null);
    if (!feedback) throw conflict("Goal feedback could not be recorded");
    if (feedback.contentHash !== contentHash) {
      throw conflict("Goal feedback idempotency key was reused with a different payload");
    }
    const dispatch = await ensureGoalWakeupIntent(database, goal, {
      event: "goal_feedback",
      eventId: feedback.id,
      actor: { actorType: "user", actorId: actorUserId },
      feedback: { id: feedback.id, body: feedback.body, kind: feedback.feedbackKind },
    });
    if (feedback.routedWakeupRequestId && feedback.routedWakeupRequestId !== dispatch.wakeupRequestId) {
      throw conflict("Goal feedback is linked to a different Owner wakeup");
    }
    const routedFeedback = feedback.routedWakeupRequestId
      ? feedback
      : await database.update(goalFeedbackEntries).set({
        routedWakeupRequestId: dispatch.wakeupRequestId,
        updatedAt: new Date(),
      }).where(and(
        eq(goalFeedbackEntries.id, feedback.id),
        eq(goalFeedbackEntries.orgId, goal.orgId),
        isNull(goalFeedbackEntries.routedWakeupRequestId),
      )).returning().then((rows) => rows[0] ?? feedback);
    return { feedback: routedFeedback, dispatch };
  }

  async function evaluateInTransaction(
    database: Database,
    current: GoalRow,
    input: EvaluateGoal,
    actorAgentId: string | null,
  ) {
    assertCanonicalActiveGoal(current);
    assertGoalOwner(current, actorAgentId);
    const evaluation = reduceGoalEvaluation(current, input);
    const terminal = isTerminalEvaluation(evaluation.outcome);
    let acceptedProposal: typeof goalResultProposals.$inferSelect | null = null;
    if (terminal) {
      if (!input.resultProposalId) {
        throw conflict("Terminal Goal evaluation requires an accepted Result Proposal");
      }
      acceptedProposal = await database.select().from(goalResultProposals).where(and(
        eq(goalResultProposals.id, input.resultProposalId),
        eq(goalResultProposals.goalId, current.id),
        eq(goalResultProposals.orgId, current.orgId),
      )).then((rows) => rows[0] ?? null);
      const candidate = evaluationCandidate(input);
      if (!acceptedProposal
        || acceptedProposal.status !== "accepted"
        || acceptedProposal.acceptedByActorType !== "user"
        || !acceptedProposal.acceptedByActorId
        || !acceptedProposal.acceptedAt
        || acceptedProposal.consumedAt
        || acceptedProposal.contractRevision !== current.contractRevision
        || acceptedProposal.candidateHash !== stableGoalHash(candidate)
        || !sameHashPayload(acceptedProposal.candidate, candidate)) {
        throw conflict("Accepted Result Proposal does not match the current Goal and evaluation candidate");
      }
      const consumed = await database.update(goalResultProposals).set({
        consumedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(goalResultProposals.id, acceptedProposal.id),
        isNull(goalResultProposals.consumedAt),
      )).returning().then((rows) => rows[0] ?? null);
      if (!consumed) throw conflict("Result Proposal was already consumed");
    }

    const lifecycle = terminal ? "closed" as const : "active" as const;
    const status = terminal
      ? positiveOutcome(current.objectiveMode, evaluation.outcome) ? "achieved" as const : "cancelled" as const
      : "active" as const;
    const [goal] = await database.update(goals).set({
      lifecycle,
      status,
      ...(terminal ? { focus: false, closeReason: "evaluated" as const } : {}),
      evaluationResult: evaluation,
      resultPayload: input.resultPayload,
      updatedAt: new Date(),
    }).where(and(
      eq(goals.id, current.id),
      eq(goals.orgId, current.orgId),
      eq(goals.lifecycle, "active"),
      eq(goals.contractRevision, current.contractRevision),
    )).returning();
    if (!goal) throw conflict("Goal changed before evaluation; reload and retry");
    await database.insert(goalActivities).values({
      orgId: current.orgId,
      goalId: current.id,
      contractRevision: current.contractRevision,
      submittedByAgentId: actorAgentId,
      agentOwnerRefAtTime: current.ownerAgentId,
      activityKind: "closeout",
      summary: publicGoalOutcome(evaluation.outcome),
      evidenceRefs: input.evidenceRefs,
      idempotencyKey: acceptedProposal ? `goal-result-evaluation:${acceptedProposal.id}` : null,
    }).onConflictDoNothing();
    return goal;
  }

  async function historyFor(
    id: string,
    options: { cursor?: string | null; limit?: number } = {},
  ): Promise<GoalHistoryPage> {
    const goal = await requireGoal(db, id);
    const cursor = decodeGoalHistoryCursor(options.cursor);
    const limit = options.limit ?? GOAL_HISTORY_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > GOAL_HISTORY_MAX_LIMIT) {
      throw badRequest(`Goal history limit must be between 1 and ${GOAL_HISTORY_MAX_LIMIT}`);
    }
    const perSourceLimit = limit + 1;
    const [activityRows, feedbackRows, changeRows, resultRows] = await Promise.all([
      db.select().from(goalActivities).where(and(
        eq(goalActivities.goalId, id),
        historyCursorCondition(goalActivities.occurredAt, goalActivities.id, "activity", cursor),
      )).orderBy(desc(goalActivities.occurredAt), asc(goalActivities.id)).limit(perSourceLimit),
      db.select().from(goalFeedbackEntries).where(and(
        eq(goalFeedbackEntries.goalId, id),
        historyCursorCondition(goalFeedbackEntries.createdAt, goalFeedbackEntries.id, "feedback", cursor),
      )).orderBy(desc(goalFeedbackEntries.createdAt), asc(goalFeedbackEntries.id)).limit(perSourceLimit),
      db.select().from(goalChangeProposals).where(and(
        eq(goalChangeProposals.goalId, id),
        historyCursorCondition(goalChangeProposals.createdAt, goalChangeProposals.id, "change_proposal", cursor),
      )).orderBy(desc(goalChangeProposals.createdAt), asc(goalChangeProposals.id)).limit(perSourceLimit),
      db.select().from(goalResultProposals).where(and(
        eq(goalResultProposals.goalId, id),
        historyCursorCondition(goalResultProposals.createdAt, goalResultProposals.id, "result_proposal", cursor),
      )).orderBy(desc(goalResultProposals.createdAt), asc(goalResultProposals.id)).limit(perSourceLimit),
    ]);

    const agentIds = Array.from(new Set([
      ...activityRows.map((row) => row.submittedByAgentId),
      ...changeRows.map((row) => row.proposedByAgentId),
      ...resultRows.map((row) => row.proposedByAgentId),
    ].filter((value): value is string => Boolean(value))));
    const userIds = Array.from(new Set(feedbackRows.map((row) => row.actorId).filter(Boolean)));
    const attachmentAssetIds = Array.from(new Set(feedbackRows.flatMap((row) => row.attachments).flatMap((attachment) => {
      const match = attachment.uri.match(/^asset:\/\/([0-9a-f-]{36})$/i);
      return match?.[1] ? [match[1]] : [];
    })));
    const [agentRows, userRows, assetRows] = await Promise.all([
      agentIds.length > 0
        ? db.select({ id: agents.id, name: agents.name }).from(agents).where(and(
          eq(agents.orgId, goal.orgId),
          inArray(agents.id, agentIds),
        ))
        : Promise.resolve([]),
      userIds.length > 0
        ? db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, userIds))
        : Promise.resolve([]),
      attachmentAssetIds.length > 0
        ? db.select({ id: assets.id }).from(assets).where(and(
          eq(assets.orgId, goal.orgId),
          inArray(assets.id, attachmentAssetIds),
        ))
        : Promise.resolve([]),
    ]);
    const agentNames = new Map(agentRows.map((row) => [row.id, row.name]));
    const userNames = new Map(userRows.map((row) => [row.id, row.name]));
    const validAssetIds = new Set(assetRows.map((row) => row.id));
    const actorName = (actorType: "user" | "agent" | "system", actorId: string | null) => {
      if (actorType === "system") return "System";
      if (actorType === "agent") return actorId ? agentNames.get(actorId) ?? "Former agent" : "System";
      return actorId ? userNames.get(actorId) ?? "Board user" : "Board user";
    };
    const items: GoalHistoryItem[] = [
      ...activityRows.map((activity) => {
        const actorType = activity.submittedByAgentId ? "agent" as const : "system" as const;
        return {
          id: activity.id,
          kind: "activity" as const,
          summary: publicGoalActivitySummary(activity),
          createdAt: activity.occurredAt,
          evidenceRefs: stringEvidenceRefs(activity.evidenceRefs),
          actorType,
          actorId: activity.submittedByAgentId,
          actorName: actorName(actorType, activity.submittedByAgentId),
          attachments: [],
        };
      }),
      ...feedbackRows.map((entry) => ({
        id: entry.id,
        kind: "feedback" as const,
        summary: entry.body,
        createdAt: entry.createdAt,
        evidenceRefs: [],
        actorType: "user" as const,
        actorId: entry.actorId,
        actorName: actorName("user", entry.actorId),
        attachments: entry.attachments.map((attachment) => {
          const match = attachment.uri.match(/^asset:\/\/([0-9a-f-]{36})$/i);
          const assetId = match?.[1] ?? null;
          return {
            name: attachment.name,
            mimeType: attachment.mimeType ?? null,
            size: attachment.size ?? null,
            contentPath: assetId && validAssetIds.has(assetId) ? `/api/assets/${assetId}/content` : null,
          };
        }),
        feedbackKind: entry.feedbackKind,
      })),
      ...changeRows.map((proposal) => ({
        id: proposal.id,
        kind: "change_proposal" as const,
        summary: proposal.rationale,
        createdAt: proposal.createdAt,
        evidenceRefs: proposal.evidenceRefs,
        actorType: "agent" as const,
        actorId: proposal.proposedByAgentId,
        actorName: actorName("agent", proposal.proposedByAgentId),
        attachments: [],
        approvalId: proposal.approvalId,
        status: proposal.status,
      })),
      ...resultRows.map((proposal) => ({
        id: proposal.id,
        kind: "result_proposal" as const,
        summary: `${publicGoalOutcome(proposal.preflight.outcome)}. ${proposal.riskSummary}`,
        createdAt: proposal.createdAt,
        evidenceRefs: proposal.candidate.evidenceRefs,
        actorType: "agent" as const,
        actorId: proposal.proposedByAgentId,
        actorName: actorName("agent", proposal.proposedByAgentId),
        attachments: [],
        status: proposal.status,
      })),
    ].sort((left, right) => {
      const timeDifference = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
      if (timeDifference !== 0) return timeDifference;
      const kindDifference = left.kind.localeCompare(right.kind);
      return kindDifference !== 0 ? kindDifference : left.id.localeCompare(right.id);
    });
    const pageItems = items.slice(0, limit);
    return {
      items: pageItems,
      nextCursor: items.length > limit && pageItems.length > 0
        ? encodeGoalHistoryCursor(pageItems[pageItems.length - 1]!)
        : null,
    };
  }

  async function workspaceFor(id: string) {
    const goal = await requireGoal(db, id);
    const [ownerAssignment, plan, activities, historyPage, changes, results, evidenceActivity, pendingWakeup] = await Promise.all([
      db.select().from(goalOwnerAssignments).where(and(
        eq(goalOwnerAssignments.goalId, id),
        isNull(goalOwnerAssignments.endsAt),
      )).then((rows) => rows[0] ?? null),
      goal.planRevision > 0
        ? db.select().from(goalPlans).where(and(
          eq(goalPlans.goalId, id),
          eq(goalPlans.revision, goal.planRevision),
        )).then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      db.select().from(goalActivities).where(eq(goalActivities.goalId, id))
        .orderBy(desc(goalActivities.occurredAt), desc(goalActivities.createdAt)).limit(100),
      historyFor(id),
      db.select().from(goalChangeProposals).where(and(
        eq(goalChangeProposals.goalId, id),
        eq(goalChangeProposals.status, "pending"),
      )).orderBy(asc(goalChangeProposals.createdAt)),
      db.select().from(goalResultProposals).where(and(
        eq(goalResultProposals.goalId, id),
        inArray(goalResultProposals.status, ["ready", "accepted"]),
      )).orderBy(desc(goalResultProposals.createdAt)),
      db.select().from(goalActivities).where(and(
        eq(goalActivities.goalId, id),
        inArray(goalActivities.activityKind, [...CURRENT_PROGRESS_ACTIVITY_KINDS]),
        or(
          isNotNull(goalActivities.runRef),
          sql`${goalActivities.idempotencyKey} like 'goal-result-evidence:%'`,
        ),
        sql`jsonb_array_length(${goalActivities.evidenceRefs}) > 0`,
      )).orderBy(desc(goalActivities.occurredAt), desc(goalActivities.createdAt)).limit(1)
        .then((rows) => rows[0] ?? null),
      pendingGoalWakeup(goal),
    ]);
    const externalWorkFact = await latestExternalWorkFact(
      goal,
      typeof evidenceActivity?.runRef === "string" ? evidenceActivity.runRef : null,
    );
    const acceptedResult = results.find((proposal) => proposal.status === "accepted") ?? null;
    const progressSource = evidenceActivity
      ? {
        summary: acceptedResult
          ? publicGoalOutcome(acceptedResult.preflight.outcome)
          : publicGoalActivitySummary(evidenceActivity),
        sourceActivityId: evidenceActivity.id,
        evidenceRefs: stringEvidenceRefs(evidenceActivity.evidenceRefs),
      }
      : null;
    const pendingChange = changes[0] ?? null;
    const readyResult = results.find((proposal) => proposal.status === "ready") ?? null;
    const facet = facetFor(goal, pendingChange, readyResult, pendingWakeup);
    const wakeupAttentionReason = goalWakeupAttentionReason(pendingWakeup);
    const attention = goal.lifecycle === "closed"
      ? null
      : readyResult
        ? {
          kind: "result_proposal" as const,
          reason: "Review the proposed Goal result and decide whether it is sufficient.",
          sourceId: readyResult.id,
        }
        : pendingChange
          ? {
            kind: "change_proposal" as const,
            reason: pendingChange.rationale,
            sourceId: pendingChange.id,
          }
          : goal.lifecycle === "draft" && goal.alignmentQuestion
            ? { kind: "alignment_question" as const, reason: goal.alignmentQuestion, sourceId: goal.id }
            : wakeupAttentionReason
              ? { kind: "owner_blocked" as const, reason: wakeupAttentionReason, sourceId: pendingWakeup?.status ?? null }
              : null;
    return {
      goal: { ...goal, ownerAssignment, plan, activities },
      facet,
      currentGoal: { summary: goal.outcomeStatement ?? goal.title, revision: goal.contractRevision },
      currentProgress: progressSource
        ? {
          summary: progressSource.summary,
          sourceActivityId: progressSource.sourceActivityId,
          evidenceRefs: progressSource.evidenceRefs,
        }
        : {
          summary: "No evidence-backed progress has been recorded yet.",
          sourceActivityId: null,
          evidenceRefs: [],
        },
      agentAction: externalWorkFact
        ? {
          summary: externalWorkFact.summary,
          sourceIds: [externalWorkFact.sourceId],
          ...(externalWorkFact.runStatus ? { status: externalWorkFact.runStatus } : {}),
        }
        : null,
      nextStep: goal.continuationKind && goal.continuationSummary
        ? {
          kind: goal.continuationKind,
          summary: goal.continuationSummary,
          wakeCondition: goal.wakeCondition,
        }
        : null,
      attention,
      timeline: historyPage.items,
      timelineNextCursor: historyPage.nextCursor,
      changeProposals: changes,
      resultProposals: results,
    };
  }

  return {
    list: (orgId: string) => db.select().from(goals).where(eq(goals.orgId, orgId)).orderBy(asc(goals.createdAt)),

    getById: (id: string) => db.select().from(goals).where(eq(goals.id, id)).then((rows) => rows[0] ?? null),

    getChangeProposalById: (id: string) => db.select().from(goalChangeProposals)
      .where(eq(goalChangeProposals.id, id)).then((rows) => rows[0] ?? null),

    getResultProposalById: (id: string) => db.select().from(goalResultProposals)
      .where(eq(goalResultProposals.id, id)).then((rows) => rows[0] ?? null),

    dependencies: (goal: GoalRow) => getGoalDependencies(db, goal),

    history: historyFor,

    previewStart: async (orgId: string, input: PreviewGoalStart) => {
      if (!hasConcreteGoalOutcome(input)) return compileGoalStartPreview(input, null);
      const owner = input.ownerAgentId
        ? await db.select({
          id: agents.id,
          orgId: agents.orgId,
          name: agents.name,
          status: agents.status,
          role: agents.role,
          title: agents.title,
          capabilities: agents.capabilities,
        })
          .from(agents).where(and(eq(agents.id, input.ownerAgentId), eq(agents.orgId, orgId)))
          .then((rows) => rows[0] ?? null)
        : null;
      return compileGoalStartPreview(input, owner as GoalAgent | null);
    },

    start: async (
      orgId: string,
      input: StartGoal,
      actor: GoalWakeupActor = { actorType: "system", actorId: null },
    ) => {
      const computedHash = stableGoalHash(input.packet);
      if (computedHash !== input.packetHash) {
        throw conflict("Goal Start packet hash does not match the submitted packet");
      }
      const replay = await db.select().from(goalStartRequests).where(and(
        eq(goalStartRequests.orgId, orgId),
        eq(goalStartRequests.requestKey, input.requestKey),
      )).then((rows) => rows[0] ?? null);
      if (replay) {
        if (replay.packetHash !== input.packetHash) {
          throw conflict("Goal Start request key was reused with a different packet hash");
        }
        if (!sameHashPayload(replay.packet, input.packet)) {
          throw conflict("Goal Start request packet does not match the original request");
        }
        if (replay.status !== "completed" || !replay.goalId) {
          throw conflict("Goal Start request has not completed");
        }
        const goal = await db.select().from(goals).where(and(
          eq(goals.id, replay.goalId),
          eq(goals.orgId, orgId),
        )).then((rows) => rows[0] ?? null);
        if (!goal) throw conflict("Completed Goal Start request has no Goal");
        const dispatch = await ensureGoalWakeupIntent(db, goal, {
          event: "goal_started",
          eventId: replay.id,
          actor,
        });
        return { goal, replayed: true, dispatch };
      }

      return db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const owner = await requireInvokableOwner(database, orgId, input.packet.ownerAgentId);
        if (!ownerCanAdvanceGoal(owner, {
          title: input.packet.title,
          context: input.packet.description,
          ownerAgentId: input.packet.ownerAgentId,
          targetTime: input.packet.activation.evaluationDeadline ?? null,
        }) && !input.allowCapabilityMismatch) {
          throw unprocessable("Goal owner capabilities no longer match the Goal; confirm the warning before starting");
        }
        const [insertedRequest] = await database.insert(goalStartRequests).values({
          orgId,
          requestKey: input.requestKey,
          packetHash: input.packetHash,
          packet: input.packet,
          draftGoalId: input.draftGoalId ?? null,
          status: "pending",
        }).onConflictDoNothing().returning();
        if (!insertedRequest) {
          const existing = await database.select().from(goalStartRequests).where(and(
            eq(goalStartRequests.orgId, orgId),
            eq(goalStartRequests.requestKey, input.requestKey),
          )).then((rows) => rows[0] ?? null);
          if (!existing || existing.packetHash !== input.packetHash || !sameHashPayload(existing.packet, input.packet)) {
            throw conflict("Goal Start request key was reused with a different packet hash");
          }
          if (existing.status !== "completed" || !existing.goalId) {
            throw conflict("Goal Start request has not completed");
          }
          const existingGoal = await database.select().from(goals).where(and(
            eq(goals.id, existing.goalId),
            eq(goals.orgId, orgId),
          )).then((rows) => rows[0] ?? null);
          if (!existingGoal) throw conflict("Completed Goal Start request has no Goal");
          const dispatch = await ensureGoalWakeupIntent(database, existingGoal, {
            event: "goal_started",
            eventId: existing.id,
            actor,
          });
          return { goal: existingGoal, replayed: true, dispatch };
        }

        let draft: GoalRow | null;
        if (input.draftGoalId) {
          draft = await database.select().from(goals).where(and(
            eq(goals.id, input.draftGoalId),
            eq(goals.orgId, orgId),
            eq(goals.lifecycle, "draft"),
          )).then((rows) => rows[0] ?? null);
          if (!draft) throw conflict("Reusable Goal Draft was not found in this organization");
          const updatedDraft = await database.update(goals).set({
            title: input.packet.title,
            description: input.packet.description,
            alignmentQuestion: null,
            updatedAt: new Date(),
          }).where(and(
            eq(goals.id, input.draftGoalId),
            eq(goals.orgId, orgId),
            eq(goals.lifecycle, "draft"),
          )).returning().then((rows) => rows[0] ?? null);
          if (!updatedDraft) throw conflict("Goal Draft changed before start; reload and retry");
          draft = updatedDraft;
        } else {
          draft = await database.insert(goals).values({
            orgId,
            title: input.packet.title,
            description: input.packet.description,
            alignmentQuestion: null,
            level: "task",
            status: "planned",
            lifecycle: "draft",
            parentId: null,
            ownerAgentId: null,
          }).returning().then((rows) => rows[0] ?? null);
        }
        if (!draft) throw conflict("Goal Draft could not be created");

        const activation = input.packet.activation;
        const [goal] = await database.update(goals).set({
          outcomeStatement: activation.outcomeStatement,
          objectiveMode: activation.objectiveMode,
          lifecycle: "active",
          status: "active",
          contractRevision: 1,
          criteria: activation.criteria,
          autonomyEnvelope: activation.autonomyEnvelope,
          humanAuthorities: activation.humanAuthorities,
          evaluationPolicy: activation.evaluationPolicy,
          actionDeadline: activation.actionDeadline ?? null,
          evaluationDeadline: activation.evaluationDeadline ?? null,
          ownerAgentId: input.packet.ownerAgentId,
          planRevision: 1,
          continuationKind: activation.initialContinuation.kind,
          continuationSummary: activation.initialContinuation.summary,
          wakeCondition: activation.initialContinuation.wakeCondition ?? null,
          alignmentQuestion: null,
          updatedAt: new Date(),
        }).where(and(
          eq(goals.id, draft.id),
          eq(goals.orgId, orgId),
          eq(goals.lifecycle, "draft"),
        )).returning();
        if (!goal) throw conflict("Goal changed before start activation; reload and retry");
        await database.insert(goalOwnerAssignments).values({
          orgId,
          goalId: goal.id,
          agentId: input.packet.ownerAgentId,
          assignedByAuthorityRef: `goal_start:${insertedRequest.id}`,
          assignmentRevision: 1,
        });
        await database.insert(goalPlans).values({
          orgId,
          goalId: goal.id,
          revision: 1,
          ...activation.initialPlan,
          createdByAgentId: null,
        });
        await database.insert(goalActivities).values({
          orgId,
          goalId: goal.id,
          contractRevision: 1,
          submittedByAgentId: null,
          agentOwnerRefAtTime: input.packet.ownerAgentId,
          activityKind: "progress",
          summary: `Goal activated with initial ${activation.initialContinuation.kind}: ${activation.initialContinuation.summary}`,
          evidenceRefs: [],
          idempotencyKey: `goal-start:${insertedRequest.id}`,
        });
        const completedAt = new Date();
        const completedRequest = await database.update(goalStartRequests).set({
          goalId: goal.id,
          status: "completed",
          completedAt,
          updatedAt: completedAt,
        }).where(and(
          eq(goalStartRequests.id, insertedRequest.id),
          eq(goalStartRequests.status, "pending"),
        )).returning().then((rows) => rows[0] ?? null);
        if (!completedRequest) throw conflict("Goal Start request could not be completed");
        const dispatch = await ensureGoalWakeupIntent(database, goal, {
          event: "goal_started",
          eventId: completedRequest.id,
          actor,
        });
        return { goal, replayed: false, dispatch };
      });
    },

    workspace: workspaceFor,

    workspaceCards: async (orgId: string) => {
      const organizationGoals = await db.select().from(goals).where(eq(goals.orgId, orgId))
        .orderBy(asc(goals.createdAt));
      return Promise.all(organizationGoals.map(async (goal) => {
        const [progress, pendingChange, readyResult, owner, pendingWakeup] = await Promise.all([
          db.select().from(goalActivities).where(and(
            eq(goalActivities.goalId, goal.id),
            inArray(goalActivities.activityKind, [...CURRENT_PROGRESS_ACTIVITY_KINDS]),
            or(
              isNotNull(goalActivities.runRef),
              sql`${goalActivities.idempotencyKey} like 'goal-result-evidence:%'`,
            ),
            sql`jsonb_array_length(${goalActivities.evidenceRefs}) > 0`,
          )).orderBy(desc(goalActivities.occurredAt), desc(goalActivities.createdAt)).limit(1)
            .then((rows) => rows[0] ?? null),
          db.select().from(goalChangeProposals).where(and(
            eq(goalChangeProposals.goalId, goal.id),
            eq(goalChangeProposals.status, "pending"),
          )).orderBy(asc(goalChangeProposals.createdAt)).limit(1).then((rows) => rows[0] ?? null),
          db.select().from(goalResultProposals).where(and(
            eq(goalResultProposals.goalId, goal.id),
            eq(goalResultProposals.status, "ready"),
          )).orderBy(asc(goalResultProposals.createdAt)).limit(1).then((rows) => rows[0] ?? null),
          goal.ownerAgentId
            ? db.select({ name: agents.name }).from(agents).where(and(
              eq(agents.id, goal.ownerAgentId),
              eq(agents.orgId, orgId),
            )).then((rows) => rows[0] ?? null)
            : Promise.resolve(null),
          pendingGoalWakeup(goal),
        ]);
        const currentProgress = progress
          ? publicGoalActivitySummary(progress)
          : "No evidence-backed progress has been recorded yet.";
        const attentionReason = goal.lifecycle === "closed"
          ? null
          : readyResult
            ? `Review the proposed Goal result: ${publicGoalOutcome(readyResult.preflight.outcome)}`
            : pendingChange?.rationale
              ?? (goal.lifecycle === "draft" ? goal.alignmentQuestion : null)
              ?? goalWakeupAttentionReason(pendingWakeup);
        return {
          id: goal.id,
          orgId: goal.orgId,
          title: goal.title,
          lifecycle: goal.lifecycle,
          status: goal.status,
          facet: facetFor(goal, pendingChange, readyResult, pendingWakeup),
          ownerAgentId: goal.ownerAgentId,
          ownerName: owner?.name ?? null,
          currentProgress,
          progressSummary: currentProgress,
          nextAction: goal.continuationSummary,
          nextStepSummary: goal.continuationSummary ?? "No next step has been recorded.",
          targetTime: goal.evaluationDeadline ?? goal.actionDeadline,
          attentionReason,
          focus: goal.focus,
          updatedAt: goal.updatedAt,
        };
      }));
    },

    detail: async (id: string) => {
      const goal = await requireGoal(db, id);
      const [ownerAssignment, plan, activities] = await Promise.all([
        db.select().from(goalOwnerAssignments).where(and(eq(goalOwnerAssignments.goalId, id), isNull(goalOwnerAssignments.endsAt)))
          .then((rows) => rows[0] ?? null),
        goal.planRevision > 0
          ? db.select().from(goalPlans).where(and(eq(goalPlans.goalId, id), eq(goalPlans.revision, goal.planRevision))).then((rows) => rows[0] ?? null)
          : Promise.resolve(null),
        db.select().from(goalActivities).where(eq(goalActivities.goalId, id)).orderBy(desc(goalActivities.occurredAt), desc(goalActivities.createdAt)).limit(100),
      ]);
      return { ...goal, ownerAssignment, plan, activities };
    },

    create: async (orgId: string, data: {
      title: string;
      description?: string | null;
      alignmentQuestion?: string | null;
      ownerAgentId?: string | null;
      targetTime?: Date | null;
    }) => {
      if (data.ownerAgentId) await requireInvokableOwner(db, orgId, data.ownerAgentId);
      return db.insert(goals).values({
        orgId,
        title: data.title,
        description: data.description ?? null,
        alignmentQuestion: data.alignmentQuestion ?? null,
        evaluationDeadline: data.targetTime ?? null,
        level: "task",
        status: "planned",
        lifecycle: "draft",
        parentId: null,
        ownerAgentId: data.ownerAgentId ?? null,
      }).returning().then((rows) => rows[0]);
    },

    update: async (id: string, data: {
      title?: string;
      description?: string | null;
      alignmentQuestion?: string | null;
      ownerAgentId?: string | null;
      targetTime?: Date | null;
    }, actorAgentId: string | null = null) => {
      return db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const current = await requireGoalForUpdate(database, id);
        assertGoalOwner(current, actorAgentId);
        if (current.lifecycle === "closed") {
          throw conflict("Closed Goals are read-only");
        }
        if (current.lifecycle !== "draft" && actorAgentId) {
          throw forbidden("Active Goal direction changes require a human-approved Goal change proposal");
        }
        if ((data.ownerAgentId !== undefined || data.targetTime !== undefined) && current.lifecycle !== "draft") {
          throw conflict("Owner and target time can only be edited while a Goal is a Draft");
        }
        if (data.ownerAgentId) await requireInvokableOwner(database, current.orgId, data.ownerAgentId);
        const { title, description, alignmentQuestion, ownerAgentId, targetTime } = data;
        const changedGoal = await database.update(goals).set({
          title,
          description,
          alignmentQuestion,
          ...(ownerAgentId !== undefined ? { ownerAgentId } : {}),
          ...(targetTime !== undefined ? { evaluationDeadline: targetTime } : {}),
          updatedAt: new Date(),
        })
          .where(and(eq(goals.id, id), eq(goals.lifecycle, current.lifecycle)))
          .returning().then((rows) => rows[0] ?? null);
        if (!changedGoal) throw conflict("Goal changed before update; reload and retry");
        return changedGoal;
      });
    },

    activate: async (id: string, input: ActivateGoal, actorAgentId: string | null = null) => {
      const current = await requireGoal(db, id);
      if (current.lifecycle !== "draft") throw conflict("Only draft Goals can be activated");
      if (actorAgentId && actorAgentId !== input.ownerAgentId) {
        throw forbidden("An Agent can only activate a Goal for itself as Owner");
      }
      await requireInvokableOwner(db, current.orgId, input.ownerAgentId);
      const result = await db.transaction(async (tx) => {
        const [goal] = await tx.update(goals).set({
          outcomeStatement: input.outcomeStatement,
          objectiveMode: input.objectiveMode,
          lifecycle: "active",
          status: "active",
          contractRevision: 1,
          criteria: input.criteria,
          autonomyEnvelope: input.autonomyEnvelope,
          humanAuthorities: input.humanAuthorities,
          evaluationPolicy: input.evaluationPolicy,
          actionDeadline: input.actionDeadline ?? null,
          evaluationDeadline: input.evaluationDeadline ?? null,
          ownerAgentId: input.ownerAgentId,
          planRevision: 1,
          continuationKind: input.initialContinuation.kind,
          continuationSummary: input.initialContinuation.summary,
          wakeCondition: input.initialContinuation.wakeCondition ?? null,
          alignmentQuestion: null,
          updatedAt: new Date(),
        }).where(and(eq(goals.id, id), eq(goals.lifecycle, "draft"))).returning();
        if (!goal) throw conflict("Goal changed before activation; reload and retry");
        await tx.insert(goalOwnerAssignments).values({
          orgId: current.orgId,
          goalId: id,
          agentId: input.ownerAgentId,
          assignedByAuthorityRef: "activation",
          assignmentRevision: 1,
        });
        await tx.insert(goalPlans).values({
          orgId: current.orgId,
          goalId: id,
          revision: 1,
          ...input.initialPlan,
          createdByAgentId: actorAgentId,
        });
        await tx.insert(goalActivities).values({
          orgId: current.orgId,
          goalId: id,
          contractRevision: 1,
          submittedByAgentId: actorAgentId,
          agentOwnerRefAtTime: input.ownerAgentId,
          activityKind: "progress",
          summary: `Goal activated with initial ${input.initialContinuation.kind}: ${input.initialContinuation.summary}`,
          evidenceRefs: [],
        });
        return goal;
      });
      return result;
    },

    updatePlan: async (id: string, input: UpdateGoalPlan, actorAgentId: string | null = null) => {
      return db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const current = await requireGoalForUpdate(database, id);
        assertCanonicalActiveGoal(current);
        assertGoalOwner(current, actorAgentId);
        const revision = current.planRevision + 1;
        const [plan] = await database.insert(goalPlans).values({
          orgId: current.orgId,
          goalId: id,
          revision,
          ...input,
          createdByAgentId: actorAgentId,
        }).returning();
        const changedGoal = await database.update(goals).set({ planRevision: revision, updatedAt: new Date() })
          .where(and(eq(goals.id, id), eq(goals.lifecycle, "active"), eq(goals.planRevision, current.planRevision)))
          .returning().then((rows) => rows[0] ?? null);
        if (!changedGoal) throw conflict("Goal changed before Plan update; reload and retry");
        return plan;
      });
    },

    listActivities: (id: string) => db.select().from(goalActivities).where(eq(goalActivities.goalId, id))
      .orderBy(desc(goalActivities.occurredAt), desc(goalActivities.createdAt)).limit(100),

    createActivity: async (id: string, input: CreateGoalActivity, actorAgentId: string | null = null) => {
      return db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const current = await requireGoalForUpdate(database, id);
        assertCanonicalActiveGoal(current);
        assertGoalOwner(current, actorAgentId);
        if (actorAgentId && !input.runRef) {
          throw unprocessable("Goal Activity must be attributed to the acting Agent's Run");
        }
        if (input.activityKind === "closeout" && !input.runRef) {
          throw unprocessable("A closeout Activity requires a Run reference");
        }
        if (input.runRef) {
          const run = await requireGoalRun(database, current, input.runRef, actorAgentId);
          if (input.activityKind === "closeout" && !TERMINAL_RUN_STATUSES.includes(run.status as typeof TERMINAL_RUN_STATUSES[number])) {
            throw conflict("A closeout Activity requires a terminal Run");
          }
        }
        const [activity] = await database.insert(goalActivities).values({
          orgId: current.orgId,
          goalId: id,
          contractRevision: current.contractRevision,
          submittedByAgentId: actorAgentId,
          agentOwnerRefAtTime: current.ownerAgentId,
          activityKind: input.activityKind ?? "progress",
          commitmentRef: input.commitmentRef ?? null,
          runRef: input.runRef ?? null,
          summary: input.summary,
          evidenceRefs: input.evidenceRefs,
          idempotencyKey: input.idempotencyKey ?? null,
          occurredAt: input.occurredAt ?? new Date(),
        }).onConflictDoNothing().returning();
        if (activity) return activity;
        if (input.idempotencyKey) {
          const existingIdempotent = await database.select().from(goalActivities).where(and(
            eq(goalActivities.goalId, id),
            eq(goalActivities.idempotencyKey, input.idempotencyKey),
          )).then((rows) => rows[0] ?? null);
          if (existingIdempotent) return existingIdempotent;
        }
        if (input.activityKind === "closeout" && input.runRef) {
          const existingCloseout = await database.select().from(goalActivities).where(and(
            eq(goalActivities.goalId, id),
            eq(goalActivities.runRef, input.runRef),
            eq(goalActivities.activityKind, "closeout"),
          )).then((rows) => rows[0] ?? null);
          if (existingCloseout) throw conflict("A closeout Activity already exists for this Run");
        }
        throw conflict("Goal Activity was already recorded");
      });
    },

    feedback: async (id: string, input: CreateGoalFeedback, actorUserId: string) => {
      return db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const current = await requireGoalForUpdate(database, id);
        return recordFeedback(database, current, input, actorUserId);
      });
    },

    createChangeProposal: async (
      id: string,
      input: CreateGoalChangeProposal,
      actorAgentId: string | null,
    ) => {
      if (!actorAgentId) throw forbidden("Only the Goal Owner Agent can propose a consequential change");
      const normalizedPatch = normalizeContractPatch(input.afterContract);
      return db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const current = await requireGoalForUpdate(database, id);
        assertCanonicalActiveGoal(current);
        assertGoalOwner(current, actorAgentId);
        const existing = await database.select().from(goalChangeProposals).where(and(
          eq(goalChangeProposals.goalId, id),
          eq(goalChangeProposals.idempotencyKey, input.idempotencyKey),
        )).then((rows) => rows[0] ?? null);
        if (existing) {
          assertSameChangeProposalPayload(existing, input, normalizedPatch);
          return existing;
        }
        if (current.contractRevision !== input.expectedContractRevision) {
          throw conflict("Goal changed before the proposed update could be created", {
            expectedContractRevision: input.expectedContractRevision,
            currentContractRevision: current.contractRevision,
          });
        }

        const beforeContract = goalContractSnapshot(current);
        const mergedContract = { ...beforeContract, ...normalizedPatch };
        activateGoalSchema.parse({
          confirmed: true,
          ownerAgentId: current.ownerAgentId,
          outcomeStatement: mergedContract.outcomeStatement,
          objectiveMode: mergedContract.objectiveMode,
          criteria: mergedContract.criteria,
          autonomyEnvelope: mergedContract.autonomyEnvelope,
          humanAuthorities: mergedContract.humanAuthorities,
          evaluationPolicy: mergedContract.evaluationPolicy,
          actionDeadline: mergedContract.actionDeadline,
          evaluationDeadline: mergedContract.evaluationDeadline,
          initialPlan: { summary: "Validate the proposed Goal update" },
          initialContinuation: {
            kind: current.continuationKind,
            summary: current.continuationSummary,
            wakeCondition: current.wakeCondition,
          },
        });
        const proposalId = randomUUID();
        const approvalId = input.approvalId ?? randomUUID();
        if (input.approvalId) {
          const linkedApproval = await database.select().from(approvals).where(eq(approvals.id, approvalId))
            .then((rows) => rows[0] ?? null);
          if (!linkedApproval
            || linkedApproval.orgId !== current.orgId
            || linkedApproval.type !== "goal_change"
            || linkedApproval.status !== "pending"
            || linkedApproval.requestedByAgentId !== actorAgentId) {
            throw unprocessable("Goal change approval must be pending and belong to the same organization");
          }
          const boundApproval = await database.update(approvals).set({
            payload: {
              goalId: id,
              proposalId,
              expectedContractRevision: current.contractRevision,
              beforeContract,
              afterContract: normalizedPatch,
              rationale: input.rationale,
              evidenceRefs: input.evidenceRefs,
            },
            updatedAt: new Date(),
          }).where(and(
            eq(approvals.id, approvalId),
            eq(approvals.status, "pending"),
          )).returning().then((rows) => rows[0] ?? null);
          if (!boundApproval) throw conflict("Goal change approval changed before it could be linked");
        } else {
          await database.insert(approvals).values({
            id: approvalId,
            orgId: current.orgId,
            type: "goal_change",
            requestedByAgentId: actorAgentId,
            requestedByUserId: null,
            status: "pending",
            payload: {
              goalId: id,
              proposalId,
              expectedContractRevision: current.contractRevision,
              beforeContract,
              afterContract: normalizedPatch,
              rationale: input.rationale,
              evidenceRefs: input.evidenceRefs,
            },
          });
        }
        const [proposal] = await database.insert(goalChangeProposals).values({
          id: proposalId,
          orgId: current.orgId,
          goalId: id,
          expectedContractRevision: current.contractRevision,
          beforeContract,
          afterContract: normalizedPatch,
          rationale: input.rationale,
          evidenceRefs: input.evidenceRefs,
          approvalId,
          status: "pending",
          idempotencyKey: input.idempotencyKey,
          proposedByAgentId: actorAgentId,
        }).onConflictDoNothing().returning();
        if (proposal) return proposal;
        const raced = await database.select().from(goalChangeProposals).where(and(
          eq(goalChangeProposals.goalId, id),
          eq(goalChangeProposals.idempotencyKey, input.idempotencyKey),
        )).then((rows) => rows[0] ?? null);
        if (!raced) throw conflict("Goal change proposal could not be recorded");
        assertSameChangeProposalPayload(raced, input, normalizedPatch);
        return raced;
      });
    },

    decideChangeProposal: async (
      proposalId: string,
      input: DecideGoalChangeProposal,
      actorUserId: string,
    ) => {
      const result = await db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const proposal = await database.select().from(goalChangeProposals)
          .where(eq(goalChangeProposals.id, proposalId)).then((rows) => rows[0] ?? null);
        if (!proposal) throw notFound("Goal change proposal not found");
        const approval = await database.select().from(approvals).where(and(
          eq(approvals.id, proposal.approvalId),
          eq(approvals.orgId, proposal.orgId),
        )).then((rows) => rows[0] ?? null);
        if (!approval || approval.type !== "goal_change") {
          throw unprocessable("Goal change proposal approval is invalid");
        }
        if ((input.decision === "approve" && proposal.status === "applied")
          || (input.decision === "reject" && proposal.status === "rejected")) {
          const current = await requireGoalForUpdate(database, proposal.goalId);
          const dispatch = await ensureGoalWakeupIntent(database, current, {
            event: "goal_change_decided",
            eventId: proposal.id,
            actor: { actorType: "user", actorId: actorUserId },
            decision: { decision: input.decision, note: approval.decisionNote, status: proposal.status },
          });
          return { proposal, stale: false, dispatch };
        }
        if (proposal.status !== "pending") {
          throw conflict(`Goal change proposal is already ${proposal.status}`);
        }
        const current = await requireGoalForUpdate(database, proposal.goalId);
        assertCanonicalActiveGoal(current);
        if (current.orgId !== proposal.orgId) throw unprocessable("Goal change proposal organization mismatch");
        if (input.decision === "reject") {
          const now = new Date();
          await database.update(approvals).set({
            status: "rejected",
            decisionNote: input.note ?? null,
            decidedByUserId: actorUserId,
            decidedAt: now,
            updatedAt: now,
          }).where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending")));
          const rejected = await database.update(goalChangeProposals).set({
            status: "rejected",
            updatedAt: now,
          }).where(and(
            eq(goalChangeProposals.id, proposal.id),
            eq(goalChangeProposals.status, "pending"),
          )).returning().then((rows) => rows[0] ?? null);
          if (!rejected) throw conflict("Goal change proposal changed before rejection");
          await database.insert(goalActivities).values({
            orgId: current.orgId,
            goalId: current.id,
            contractRevision: current.contractRevision,
            submittedByAgentId: null,
            agentOwnerRefAtTime: current.ownerAgentId,
            activityKind: "decision_requested",
            summary: `Goal change proposal rejected${input.note ? `: ${input.note}` : ""}`,
            evidenceRefs: proposal.evidenceRefs,
            idempotencyKey: `goal-change:${proposal.id}:rejected`,
          }).onConflictDoNothing();
          const dispatch = await ensureGoalWakeupIntent(database, current, {
            event: "goal_change_decided",
            eventId: proposal.id,
            actor: { actorType: "user", actorId: actorUserId },
            decision: { decision: "reject", note: input.note ?? null, status: rejected.status },
          });
          return { proposal: rejected, stale: false, dispatch };
        }

        if (current.contractRevision !== proposal.expectedContractRevision) {
          const now = new Date();
          await database.update(approvals).set({
            status: "cancelled",
            decisionNote: input.note
              ? `${input.note}\n\nNot applied because the Goal changed before this decision.`
              : "Not applied because the Goal changed before this decision.",
            decidedByUserId: actorUserId,
            decidedAt: now,
            updatedAt: now,
          }).where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending")));
          const superseded = await database.update(goalChangeProposals).set({
            status: "superseded",
            updatedAt: now,
          }).where(and(
            eq(goalChangeProposals.id, proposal.id),
            eq(goalChangeProposals.status, "pending"),
          )).returning().then((rows) => rows[0] ?? proposal);
          return { proposal: superseded, stale: true, currentRevision: current.contractRevision };
        }

        const merged = { ...proposal.beforeContract, ...proposal.afterContract };
        const validated = activateGoalSchema.parse({
          confirmed: true,
          ownerAgentId: current.ownerAgentId,
          outcomeStatement: merged.outcomeStatement,
          objectiveMode: merged.objectiveMode,
          criteria: merged.criteria,
          autonomyEnvelope: merged.autonomyEnvelope,
          humanAuthorities: merged.humanAuthorities,
          evaluationPolicy: merged.evaluationPolicy,
          actionDeadline: merged.actionDeadline,
          evaluationDeadline: merged.evaluationDeadline,
          initialPlan: { summary: "Apply the approved Goal update" },
          initialContinuation: {
            kind: current.continuationKind,
            summary: current.continuationSummary,
            wakeCondition: current.wakeCondition,
          },
        });
        const now = new Date();
        const approvalUpdate = await database.update(approvals).set({
          status: "approved",
          decisionNote: input.note ?? null,
          decidedByUserId: actorUserId,
          decidedAt: now,
          updatedAt: now,
        }).where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending")))
          .returning().then((rows) => rows[0] ?? null);
        if (!approvalUpdate) throw conflict("Goal change approval changed before decision");
        const nextRevision = current.contractRevision + 1;
        const changedGoal = await database.update(goals).set({
          outcomeStatement: validated.outcomeStatement,
          objectiveMode: validated.objectiveMode,
          criteria: validated.criteria,
          autonomyEnvelope: validated.autonomyEnvelope,
          humanAuthorities: validated.humanAuthorities,
          evaluationPolicy: validated.evaluationPolicy,
          actionDeadline: validated.actionDeadline ?? null,
          evaluationDeadline: validated.evaluationDeadline ?? null,
          contractRevision: nextRevision,
          updatedAt: now,
        }).where(and(
          eq(goals.id, current.id),
          eq(goals.orgId, proposal.orgId),
          eq(goals.lifecycle, "active"),
          eq(goals.contractRevision, proposal.expectedContractRevision),
        )).returning().then((rows) => rows[0] ?? null);
        if (!changedGoal) throw conflict("Goal changed before the approved update could be applied");
        await database.insert(goalActivities).values({
          orgId: current.orgId,
          goalId: current.id,
          contractRevision: nextRevision,
          submittedByAgentId: proposal.proposedByAgentId,
          agentOwnerRefAtTime: current.ownerAgentId,
          activityKind: "decision_requested",
          summary: `Goal updated after approval: ${proposal.rationale}`,
          evidenceRefs: proposal.evidenceRefs,
          idempotencyKey: `goal-change:${proposal.id}:applied`,
        }).onConflictDoNothing();
        const applied = await database.update(goalChangeProposals).set({
          status: "applied",
          appliedRevision: nextRevision,
          appliedAt: now,
          updatedAt: now,
        }).where(and(
          eq(goalChangeProposals.id, proposal.id),
          eq(goalChangeProposals.status, "pending"),
        )).returning().then((rows) => rows[0] ?? null);
        if (!applied) throw conflict("Goal change proposal changed before application");
        const dispatch = await ensureGoalWakeupIntent(database, changedGoal, {
          event: "goal_change_decided",
          eventId: proposal.id,
          actor: { actorType: "user", actorId: actorUserId },
          decision: { decision: "approve", note: input.note ?? null, status: applied.status },
        });
        return { proposal: applied, stale: false, dispatch };
      });
      if (result.stale) {
        throw conflict("Goal changed before the approved update could be applied", {
          expectedContractRevision: result.proposal.expectedContractRevision,
          currentContractRevision: result.currentRevision,
        });
      }
      if (!result.dispatch) throw conflict("Goal change decision could not queue the Owner continuation");
      return { proposal: result.proposal, dispatch: result.dispatch };
    },

    createResultProposal: async (
      id: string,
      input: CreateGoalResultProposal,
      actorAgentId: string | null,
      actorRunId: string | null = null,
    ) => {
      if (!actorAgentId) throw forbidden("Only the Goal Owner Agent can submit a Result Proposal");
      const candidate = evaluationCandidate(input);
      const candidateHash = stableGoalHash(candidate);
      return db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const current = await requireGoalForUpdate(database, id);
        assertGoalOwner(current, actorAgentId);
        if (actorRunId) await requireGoalRun(database, current, actorRunId, actorAgentId);
        const existing = await database.select().from(goalResultProposals).where(and(
          eq(goalResultProposals.goalId, id),
          eq(goalResultProposals.idempotencyKey, input.idempotencyKey),
        )).then((rows) => rows[0] ?? null);
        if (existing) {
          assertSameResultProposalPayload(existing, input, candidateHash);
          return existing;
        }
        assertCanonicalActiveGoal(current);
        if (input.contractRevision !== current.contractRevision) {
          throw conflict("Goal changed before the result could be proposed", {
            expectedContractRevision: input.contractRevision,
            currentContractRevision: current.contractRevision,
          });
        }
        const preflight = reduceGoalEvaluation(current, candidate);
        const status = isTerminalEvaluation(preflight.outcome) ? "ready" as const : "inconclusive" as const;
        if (status === "ready") {
          const readyProposal = await database.select({ id: goalResultProposals.id })
            .from(goalResultProposals).where(and(
              eq(goalResultProposals.goalId, id),
              eq(goalResultProposals.status, "ready"),
            )).limit(1).then((rows) => rows[0] ?? null);
          if (readyProposal) {
            throw conflict("This Goal already has a Result Proposal ready for review");
          }
        }
        const [proposal] = await database.insert(goalResultProposals).values({
          orgId: current.orgId,
          goalId: current.id,
          contractRevision: current.contractRevision,
          candidate,
          candidateHash,
          preflight,
          riskSummary: input.riskSummary,
          status,
          idempotencyKey: input.idempotencyKey,
          proposedByAgentId: actorAgentId,
        }).onConflictDoNothing().returning();
        const persisted = proposal ?? await database.select().from(goalResultProposals).where(and(
          eq(goalResultProposals.goalId, id),
          eq(goalResultProposals.idempotencyKey, input.idempotencyKey),
        )).then((rows) => rows[0] ?? null);
        if (!persisted && status === "ready") {
          const readyProposal = await database.select({ id: goalResultProposals.id })
            .from(goalResultProposals).where(and(
              eq(goalResultProposals.goalId, id),
              eq(goalResultProposals.status, "ready"),
            )).limit(1).then((rows) => rows[0] ?? null);
          if (readyProposal) {
            throw conflict("This Goal already has a Result Proposal ready for review");
          }
        }
        if (!persisted) throw conflict("Goal Result Proposal could not be recorded");
        assertSameResultProposalPayload(persisted, input, candidateHash);
        if (status === "inconclusive") {
          await database.insert(goalActivities).values({
            orgId: current.orgId,
            goalId: current.id,
            contractRevision: current.contractRevision,
            submittedByAgentId: actorAgentId,
            agentOwnerRefAtTime: current.ownerAgentId,
            activityKind: "bottleneck",
            runRef: actorRunId,
            summary: inconclusiveResultSummary(preflight, input.riskSummary),
            evidenceRefs: candidate.evidenceRefs,
            idempotencyKey: `goal-result-inconclusive:${input.idempotencyKey}`,
          }).onConflictDoNothing();
          return persisted;
        }
        await database.insert(goalActivities).values({
          orgId: current.orgId,
          goalId: current.id,
          contractRevision: current.contractRevision,
          submittedByAgentId: actorAgentId,
          agentOwnerRefAtTime: current.ownerAgentId,
          activityKind: "evidence",
          runRef: actorRunId,
          summary: `${publicGoalOutcome(preflight.outcome)} is ready for review. ${input.riskSummary}`,
          evidenceRefs: candidate.evidenceRefs,
          idempotencyKey: `goal-result-evidence:${input.idempotencyKey}`,
        }).onConflictDoNothing();
        return persisted;
      });
    },

    acceptResultProposal: async (
      proposalId: string,
      input: AcceptGoalResultProposal,
      actorUserId: string,
    ) => {
      return db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const proposal = await database.select().from(goalResultProposals)
          .where(eq(goalResultProposals.id, proposalId)).then((rows) => rows[0] ?? null);
        if (!proposal) throw notFound("Goal Result Proposal not found");
        const current = await requireGoalForUpdate(database, proposal.goalId);
        if (current.orgId !== proposal.orgId) throw unprocessable("Goal Result Proposal organization mismatch");
        if (proposal.consumedAt) {
          if (proposal.acceptanceIdempotencyKey !== input.idempotencyKey) {
            throw conflict("Goal Result Proposal acceptance was replayed with a different idempotency key");
          }
          return current;
        }
        if (proposal.status !== "ready") {
          throw conflict(`Goal Result Proposal is already ${proposal.status}`);
        }
        assertCanonicalActiveGoal(current);
        if (proposal.contractRevision !== current.contractRevision) {
          throw conflict("Goal changed before the result could be accepted", {
            expectedContractRevision: proposal.contractRevision,
            currentContractRevision: current.contractRevision,
          });
        }
        if (proposal.candidateHash !== stableGoalHash(proposal.candidate)) {
          throw conflict("Goal Result Proposal candidate no longer matches its immutable hash");
        }
        const freshPreflight = reduceGoalEvaluation(current, proposal.candidate);
        if (!isTerminalEvaluation(freshPreflight.outcome)
          || !sameHashPayload(
            { ...proposal.preflight, evaluatedAt: null },
            { ...freshPreflight, evaluatedAt: null },
          )) {
          throw conflict("Goal Result Proposal no longer matches canonical evaluation");
        }
        const now = new Date();
        const accepted = await database.update(goalResultProposals).set({
          status: "accepted",
          acceptedByActorType: "user",
          acceptedByActorId: actorUserId,
          acceptanceIdempotencyKey: input.idempotencyKey,
          acceptedAt: now,
          updatedAt: now,
        }).where(and(
          eq(goalResultProposals.id, proposal.id),
          eq(goalResultProposals.status, "ready"),
          isNull(goalResultProposals.consumedAt),
        )).returning().then((rows) => rows[0] ?? null);
        if (!accepted) {
          const latestProposal = await database.select().from(goalResultProposals)
            .where(eq(goalResultProposals.id, proposal.id)).then((rows) => rows[0] ?? null);
          if (latestProposal?.consumedAt && latestProposal.acceptanceIdempotencyKey === input.idempotencyKey) {
            return requireGoalForUpdate(database, proposal.goalId);
          }
          throw conflict("Goal Result Proposal changed before acceptance");
        }
        const pendingChanges = await database.select({
          id: goalChangeProposals.id,
          approvalId: goalChangeProposals.approvalId,
        }).from(goalChangeProposals).where(and(
          eq(goalChangeProposals.goalId, current.id),
          eq(goalChangeProposals.status, "pending"),
        ));
        if (pendingChanges.length > 0) {
          await database.update(goalChangeProposals).set({
            status: "superseded",
            updatedAt: now,
          }).where(and(
            eq(goalChangeProposals.goalId, current.id),
            eq(goalChangeProposals.status, "pending"),
          ));
          await database.update(approvals).set({
            status: "cancelled",
            decisionNote: "Closed because the Goal result was accepted before this proposed change was applied.",
            decidedByUserId: actorUserId,
            decidedAt: now,
            updatedAt: now,
          }).where(and(
            inArray(approvals.id, pendingChanges.map((change) => change.approvalId)),
            inArray(approvals.status, ["pending", "revision_requested"]),
          ));
        }
        return evaluateInTransaction(database, current, {
          ...proposal.candidate,
          resultProposalId: proposal.id,
        }, null);
      });
    },

    rejectResultProposal: async (
      proposalId: string,
      input: RejectGoalResultProposal,
      actorUserId: string,
    ) => {
      return db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const proposal = await database.select().from(goalResultProposals)
          .where(eq(goalResultProposals.id, proposalId)).then((rows) => rows[0] ?? null);
        if (!proposal) throw notFound("Goal Result Proposal not found");
        if (proposal.status === "rejected") {
          if (proposal.rejectionFeedback !== input.feedback) {
            throw conflict("Goal Result Proposal rejection was replayed with different feedback");
          }
          const current = await requireGoalForUpdate(database, proposal.goalId);
          if (current.lifecycle !== "active") return { proposal, dispatch: null };
          const { dispatch } = await recordFeedback(database, current, {
            body: input.feedback,
            attachments: [],
            feedbackKind: "ordinary",
            idempotencyKey: input.idempotencyKey,
          }, actorUserId);
          return { proposal, dispatch };
        }
        if (proposal.status !== "ready") {
          throw conflict(`Goal Result Proposal is already ${proposal.status}`);
        }
        const current = await requireGoalForUpdate(database, proposal.goalId);
        assertCanonicalActiveGoal(current);
        if (current.orgId !== proposal.orgId) throw unprocessable("Goal Result Proposal organization mismatch");
        if (current.contractRevision !== proposal.contractRevision) {
          throw conflict("Goal changed before the result could be returned for more work");
        }
        const { dispatch } = await recordFeedback(database, current, {
          body: input.feedback,
          attachments: [],
          feedbackKind: "ordinary",
          idempotencyKey: input.idempotencyKey,
        }, actorUserId);
        const now = new Date();
        const rejected = await database.update(goalResultProposals).set({
          status: "rejected",
          rejectedByActorType: "user",
          rejectedByActorId: actorUserId,
          rejectedAt: now,
          rejectionFeedback: input.feedback,
          updatedAt: now,
        }).where(and(
          eq(goalResultProposals.id, proposal.id),
          eq(goalResultProposals.status, "ready"),
        )).returning().then((rows) => rows[0] ?? null);
        if (!rejected) throw conflict("Goal Result Proposal changed before rejection");
        return { proposal: rejected, dispatch };
      });
    },

    assignOwner: async (id: string, input: AssignGoalOwner, actorAgentId: string | null = null) => {
      return db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const current = await requireGoalForUpdate(database, id);
        assertCanonicalActiveGoal(current);
        assertGoalOwner(current, actorAgentId);
        await requireInvokableOwner(database, current.orgId, input.agentId);
        const previous = await database.select().from(goalOwnerAssignments)
          .where(and(eq(goalOwnerAssignments.goalId, id), isNull(goalOwnerAssignments.endsAt)))
          .then((rows) => rows[0] ?? null);
        if (previous?.agentId === input.agentId) return previous;
        const now = new Date();
        if (previous) await database.update(goalOwnerAssignments).set({ endsAt: now }).where(eq(goalOwnerAssignments.id, previous.id));
        const [assignment] = await database.insert(goalOwnerAssignments).values({
          orgId: current.orgId,
          goalId: id,
          agentId: input.agentId,
          assignmentRevision: (previous?.assignmentRevision ?? 0) + 1,
          assignedByAuthorityRef: input.authorityRef ?? null,
          startsAt: now,
        }).returning();
        const changedGoal = await database.update(goals).set({ ownerAgentId: input.agentId, updatedAt: now })
          .where(and(eq(goals.id, id), eq(goals.lifecycle, "active")))
          .returning().then((rows) => rows[0] ?? null);
        if (!changedGoal) throw conflict("Goal changed before Owner assignment; reload and retry");
        return assignment;
      });
    },

    setFocus: async (id: string, focus: boolean, actorAgentId: string | null = null) => {
      return db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const candidate = await requireGoal(database, id);
        await database.execute(sql`select id from organizations where id = ${candidate.orgId} for update`);
        const current = await requireGoalForUpdate(database, id);
        if (current.orgId !== candidate.orgId) throw conflict("Goal organization changed before Focus update; reload and retry");
        assertCanonicalActiveGoal(current);
        assertGoalOwner(current, actorAgentId);
        if (focus) await database.update(goals).set({ focus: false }).where(and(
          eq(goals.orgId, current.orgId),
          eq(goals.lifecycle, "active"),
        ));
        const [goal] = await database.update(goals).set({ focus, updatedAt: new Date() }).where(and(
          eq(goals.id, id),
          eq(goals.lifecycle, "active"),
        )).returning();
        if (!goal) throw conflict("Goal changed before Focus update; reload and retry");
        return goal;
      });
    },

    evaluate: async (id: string, input: EvaluateGoal, actorAgentId: string | null = null) => {
      return db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const current = await requireGoalForUpdate(database, id);
        return evaluateInTransaction(database, current, input, actorAgentId);
      });
    },

    remove: async (id: string) => {
      const existing = await requireGoal(db, id);
      const dependencies = await getGoalDependencies(db, existing);
      if (!dependencies.canDelete) throw conflict("Only an unlinked draft Goal can be deleted", dependencies);
      return db.delete(goals).where(eq(goals.id, id)).returning().then((rows) => rows[0] ?? null);
    },
  };
}
