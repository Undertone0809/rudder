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
  goalCheckpoints,
  goalFeedbackEntries,
  goalOwnerAssignments,
  goalPlans,
  goalResultProposals,
  goalStartRequests,
  goals,
  heartbeatRuns,
  issues,
  organizations,
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
  GoalCheckpointInput,
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
  IssueAssigneeAgentRuntimeOverrides,
  PreviewGoalStart,
  PublicGoal,
  PublicGoalActivity,
  PublicGoalChangeProposal,
  PublicGoalOwnerAssignment,
  PublicGoalPlan,
  PublicGoalResultProposal,
  RejectGoalResultProposal,
  StartGoal,
  UpdateGoalPlan,
} from "@rudderhq/shared";
import { activateGoalSchema, parseLibraryEntryMentionHref, parseLibraryFileMentionHref, parseShortRef, shortRefFor } from "@rudderhq/shared";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { createHash, randomUUID } from "node:crypto";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { buildDeferredWakePayload, readDeferredWakePayload } from "./runtime-kernel/heartbeat.sessions.js";

type GoalRow = typeof goals.$inferSelect;

function safeGoalShortRef(id: string): string | undefined {
  try {
    return shortRefFor("goal", id);
  } catch {
    return undefined;
  }
}
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
  reason: "goal_started" | "goal_feedback" | "goal_change_decided" | "goal_continuation";
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
  /(?:(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(?:%|percent|x|[kmb]|倍|个|项|天|周|月|年))|(?:[$€£¥￥]\s*\d)/i,
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

type PublicEvidenceItem = {
  label: string;
  href: string | null;
  external: boolean;
};

type PublicEvidenceOptions = {
  runAgentId?: string | null;
  orgUrlKey?: string | null;
};

function publicOrganizationHref(path: string, orgUrlKey: string | null | undefined) {
  return orgUrlKey ? `/${encodeURIComponent(orgUrlKey)}${path}` : path;
}

function publicEvidenceItems(value: unknown, options: PublicEvidenceOptions = {}): PublicEvidenceItem[] {
  return stringEvidenceRefs(value).map((reference, index) => {
    const libraryFile = parseLibraryFileMentionHref(reference);
    if (libraryFile) {
      const name = libraryFile.filePath.split("/").filter(Boolean).at(-1);
      return {
        label: name ? `Library file: ${name}` : "Library file",
        href: publicOrganizationHref(
          `/library?${new URLSearchParams({ path: libraryFile.filePath }).toString()}`,
          options.orgUrlKey,
        ),
        external: false,
      };
    }

    const libraryEntry = parseLibraryEntryMentionHref(reference);
    if (libraryEntry) {
      const search = new URLSearchParams({ entry: libraryEntry.entryId });
      if (libraryEntry.path) search.set("path", libraryEntry.path);
      return {
        label: libraryEntry.path ? `Library entry: ${libraryEntry.path.split("/").filter(Boolean).at(-1) ?? "entry"}` : "Library entry",
        href: publicOrganizationHref(`/library?${search.toString()}`, options.orgUrlKey),
        external: false,
      };
    }

    let parsed: URL | null = null;
    try {
      parsed = new URL(reference);
    } catch {
      parsed = null;
    }
    const scheme = parsed?.protocol.replace(/:$/, "").toLowerCase() ?? "";
    const entityId = parsed && !parsed.username && !parsed.password && !parsed.port
      && (parsed.pathname === "" || parsed.pathname === "/")
      && /^[a-z0-9][a-z0-9._-]*$/i.test(parsed.hostname)
      ? parsed.hostname
      : null;
    if (scheme === "issue" && entityId) {
      return {
        label: `Issue ${index + 1}`,
        href: publicOrganizationHref(`/issues/${encodeURIComponent(entityId)}`, options.orgUrlKey),
        external: false,
      };
    }
    if (scheme === "project" && entityId) {
      return {
        label: `Project ${index + 1}`,
        href: publicOrganizationHref(`/projects/${encodeURIComponent(entityId)}`, options.orgUrlKey),
        external: false,
      };
    }
    if (scheme === "approval" && entityId) {
      return {
        label: `Approval ${index + 1}`,
        href: publicOrganizationHref(`/messenger/approvals/${encodeURIComponent(entityId)}`, options.orgUrlKey),
        external: false,
      };
    }
    if (scheme === "run" && entityId && options.runAgentId) {
      return {
        label: `Supporting work ${index + 1}`,
        href: publicOrganizationHref(
          `/agents/${encodeURIComponent(options.runAgentId)}/runs/${encodeURIComponent(entityId)}`,
          options.orgUrlKey,
        ),
        external: false,
      };
    }
    if (scheme === "http" || scheme === "https") {
      return { label: `External supporting link ${index + 1}`, href: null, external: true };
    }
    const label = scheme === "artifact" ? "Supporting work" : scheme ? `${scheme} support` : "Supporting work";
    return { label: `${label} ${index + 1}`, href: null, external: false };
  });
}

async function organizationUrlKey(db: GoalReader, orgId: string) {
  return db.select({ urlKey: organizations.urlKey })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .then((rows) => rows[0]?.urlKey ?? null);
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

function goalRunAttentionReason(status: string | null | undefined) {
  if (status === "failed") return "The Owner Agent could not complete its latest action. Decide whether to retry or adjust the Goal.";
  if (status === "cancelled" || status === "canceled") return "The Owner Agent stopped its latest action. Decide whether to retry or adjust the Goal.";
  if (status === "timed_out" || status === "timeout") return "The Owner Agent's latest action timed out. Decide whether to retry or adjust the Goal.";
  return null;
}

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

const INTERNAL_GOAL_LANGUAGE = [
  [/\bgoal\s+contract\b/gi, "Goal"],
  [/\bcontract\s+revision\b/gi, "Goal update"],
  [/\bcontracts?\b/gi, "agreement"],
  [/\bobjective\s+mode\b/gi, "Goal type"],
  [/\bevaluator\b/gi, "success check"],
  [/\bevidence\s+requirements?\b/gi, "what we need to verify"],
  [/\bautonomy\s+envelope\b/gi, "working boundaries"],
  [/\bhuman\s+authorit(?:y|ies)\b/gi, "decisions that need you"],
  [/\bcontinuation\b/gi, "next step"],
  [/\bchange\s+proposal\b/gi, "Goal update"],
  [/\bresult\s+proposal\b/gi, "result review"],
  [/\bchange_proposal\b/gi, "Goal update"],
  [/\bresult_proposal\b/gi, "result review"],
  [/\bruntime\s+evidence\b/gi, "supporting evidence"],
  [/\brun\s+evidence\b/gi, "supporting work"],
  [/\bpara-memory-files\b/gi, "shared notes"],
  [/\b(?:the\s+)?[`]?shared notes[`]?\s+skill\b/gi, "shared notes"],
  [/\bdaily[- ]note\b/gi, "notes"],
  [/\b(?:runtime\s+)?evidence\s+(?:demonstrates?|shows?)\s+that\b/gi, "Supporting work shows that"],
] as const;

export function publicGoalText(value: string) {
  const mapped = INTERNAL_GOAL_LANGUAGE.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), value);
  return mapped
    .replace(/\b(?:goal-feedback|goal-start|goal-change-decision|goal-result-evaluation):[0-9a-f-]{8,}\b/gi, "the related update")
    .replace(/\b(?:artifact|run|issue|project|approval|decision|measurement|library-file|library-entry):\/\/[^\s)]+/gi, "supporting work")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "the related item")
    .replace(/\b(?:feedback|activity|proposal|request|run)\s+(?:the related item|[0-9a-f-]{8,})\b/gi, "the related update");
}

function publicGoalToken(value: string) {
  const known: Record<string, string> = {
    bounded_reversible_work: "bounded, reversible work",
    external_or_irreversible_action: "external or irreversible actions",
    external_publication: "publishing externally",
    authority_expansion: "expanding access",
    acceptance: "accepting the result",
    consequentialChanges: "consequential changes",
    externalPublication: "publishing externally",
  };
  return known[value] ?? value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
}

function publicGoalRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function publicGoalStrings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function publicGoalBoundarySummary(value: unknown) {
  const record = publicGoalRecord(value);
  const allowed = publicGoalStrings(record.allowed).map(publicGoalToken);
  const approvals = publicGoalStrings(record.requiresHumanApproval).map(publicGoalToken);
  const parts = [
    allowed.length > 0 ? `The Agent may handle ${allowed.join(", ")}.` : null,
    approvals.length > 0 ? `You will be asked before ${approvals.join(", ")}.` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : null;
}

function publicGoalAuthoritySummary(value: unknown) {
  const decisions = Object.entries(publicGoalRecord(value))
    .filter(([, entry]) => entry === "board_human" || entry === true)
    .map(([key]) => publicGoalToken(key));
  return decisions.length > 0 ? `You decide ${decisions.join(", ")}.` : null;
}

function publicGoalCompletionSummary(value: unknown) {
  const record = publicGoalRecord(value);
  const requiresEvidence = record.terminalEvidenceRequired === true;
  const requiresAcceptance = record.humanAcceptanceRequired === true;
  if (requiresEvidence && requiresAcceptance) return "Supporting work is shown, and you accept the result.";
  if (requiresEvidence) return "Supporting work is shown before the result is considered ready.";
  if (requiresAcceptance) return "You accept the result when it is ready.";
  return null;
}

function publicGoalContractSummary(value: unknown) {
  const record = publicGoalRecord(value);
  const outcomeStatement = typeof record.outcomeStatement === "string" && record.outcomeStatement.trim()
    ? publicGoalText(record.outcomeStatement)
    : null;
  const criteria = Array.isArray(record.criteria)
    ? record.criteria.flatMap((criterion) => {
      const label = publicGoalRecord(criterion).label;
      return typeof label === "string" && label.trim() ? [{ label: publicGoalText(label) }] : [];
    })
    : [];
  const targetTime = typeof record.evaluationDeadline === "string"
    ? record.evaluationDeadline
    : typeof record.actionDeadline === "string" ? record.actionDeadline : null;
  return {
    ...(outcomeStatement ? { outcomeStatement } : {}),
    ...(criteria.length > 0 ? { criteria } : {}),
    ...(targetTime ? { targetTime } : {}),
    ...(publicGoalBoundarySummary(record.autonomyEnvelope)
      ? { boundarySummary: publicGoalBoundarySummary(record.autonomyEnvelope) } : {}),
    ...(publicGoalAuthoritySummary(record.humanAuthorities)
      ? { approvalSummary: publicGoalAuthoritySummary(record.humanAuthorities) } : {}),
    ...(publicGoalCompletionSummary(record.evaluationPolicy)
      ? { completionSummary: publicGoalCompletionSummary(record.evaluationPolicy) } : {}),
  };
}

export function publicGoalView(goal: GoalRow): PublicGoal {
  const criteria = Array.isArray(goal.criteria)
    ? goal.criteria.flatMap((criterion) => {
      const record = publicGoalRecord(criterion);
      const id = typeof record.id === "string" && record.id.trim() ? record.id : null;
      const label = typeof record.label === "string" && record.label.trim()
        ? publicGoalText(record.label)
        : null;
      return id && label ? [{ id, label }] : [];
    })
    : [];
  const evaluation = publicGoalRecord(goal.evaluationResult);
  return {
    id: goal.id,
    ...(safeGoalShortRef(goal.id) ? { shortRef: safeGoalShortRef(goal.id) } : {}),
    orgId: goal.orgId,
    title: goal.title,
    description: goal.description,
    lifecycle: goal.lifecycle as PublicGoal["lifecycle"],
    status: goal.status as PublicGoal["status"],
    outcomeStatement: goal.outcomeStatement ? publicGoalText(goal.outcomeStatement) : goal.outcomeStatement,
    criteria,
    ownerAgentId: goal.ownerAgentId,
    ownerAgentRuntimeOverrides: goal.ownerAgentRuntimeOverrides,
    focus: goal.focus,
    evaluationResult: typeof evaluation.outcome === "string" ? { outcome: evaluation.outcome } : null,
    evaluationDeadline: goal.evaluationDeadline,
    actionDeadline: goal.actionDeadline,
    continuationSummary: goal.continuationSummary ? publicGoalText(goal.continuationSummary) : goal.continuationSummary,
    wakeCondition: goal.wakeCondition ? publicGoalText(goal.wakeCondition) : goal.wakeCondition,
    alignmentQuestion: goal.alignmentQuestion ? publicGoalText(goal.alignmentQuestion) : goal.alignmentQuestion,
    closeReason: goal.closeReason as PublicGoal["closeReason"],
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

export function publicGoalActivity(
  activity: typeof goalActivities.$inferSelect,
  options: PublicEvidenceOptions = {},
): PublicGoalActivity {
  return {
    id: activity.id,
    orgId: activity.orgId,
    goalId: activity.goalId,
    activityKind: activity.activityKind as PublicGoalActivity["activityKind"],
    summary: publicGoalActivitySummary(activity),
    evidence: publicEvidenceItems(activity.evidenceRefs, {
      ...options,
      runAgentId: activity.submittedByAgentId,
    }),
    occurredAt: activity.occurredAt,
    createdAt: activity.createdAt,
  };
}

export function publicGoalCheckpoint(checkpoint: typeof goalCheckpoints.$inferSelect) {
  return {
    id: checkpoint.id,
    orgId: checkpoint.orgId,
    goalId: checkpoint.goalId,
    runId: checkpoint.runId,
    ownerAgentId: checkpoint.ownerAgentId,
    submittedByAgentId: checkpoint.submittedByAgentId,
    inputHash: checkpoint.inputHash,
    idempotencyKey: checkpoint.idempotencyKey,
    summary: publicGoalText(checkpoint.summary),
    evidenceRefs: checkpoint.evidenceRefs,
    planPayload: checkpoint.planPayload,
    planRevisionBefore: checkpoint.planRevisionBefore,
    planRevisionAfter: checkpoint.planRevisionAfter,
    continuation: {
      kind: checkpoint.continuationKind,
      summary: publicGoalText(checkpoint.continuationSummary),
      wakeCondition: checkpoint.wakeCondition,
    },
    continuationWakeupRequestId: checkpoint.continuationWakeupRequestId,
    createdAt: checkpoint.createdAt,
  };
}

export function publicGoalDetail(input: GoalRow & {
  ownerAssignment: typeof goalOwnerAssignments.$inferSelect | null;
  plan: typeof goalPlans.$inferSelect | null;
  activities: typeof goalActivities.$inferSelect[];
}, options: PublicEvidenceOptions = {}) {
  return {
    ...publicGoalView(input),
    ownerAssignment: input.ownerAssignment
      ? {
        agentId: input.ownerAssignment.agentId,
        assignmentRevision: input.ownerAssignment.assignmentRevision,
        startsAt: input.ownerAssignment.startsAt,
        endsAt: input.ownerAssignment.endsAt,
      }
      : null,
    plan: input.plan
      ? {
        revision: input.plan.revision,
        summary: publicGoalText(input.plan.summary),
      }
      : null,
    activities: input.activities.map((activity) => publicGoalActivity(activity, options)),
  };
}

export function publicGoalPlan(plan: typeof goalPlans.$inferSelect): PublicGoalPlan {
  return {
    id: plan.id,
    orgId: plan.orgId,
    goalId: plan.goalId,
    revision: plan.revision,
    summary: publicGoalText(plan.summary),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

export function publicGoalOwnerAssignment(assignment: typeof goalOwnerAssignments.$inferSelect): PublicGoalOwnerAssignment {
  return {
    id: assignment.id,
    orgId: assignment.orgId,
    goalId: assignment.goalId,
    agentId: assignment.agentId,
    assignmentRevision: assignment.assignmentRevision,
    startsAt: assignment.startsAt,
    endsAt: assignment.endsAt,
    createdAt: assignment.createdAt,
  };
}

export function publicGoalFeedback(entry: typeof goalFeedbackEntries.$inferSelect) {
  return {
    id: entry.id,
    orgId: entry.orgId,
    goalId: entry.goalId,
    actorType: entry.actorType,
    actorId: entry.actorId,
    body: entry.body,
    attachments: entry.attachments.map(({ name, mimeType, size }) => ({ name, mimeType, size })),
    feedbackKind: entry.feedbackKind,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export function publicGoalChangeProposal(
  proposal: typeof goalChangeProposals.$inferSelect,
  options: PublicEvidenceOptions = {},
): PublicGoalChangeProposal {
  return {
    id: proposal.id,
    approvalId: proposal.approvalId,
    status: proposal.status,
    rationale: publicGoalText(proposal.rationale),
    evidence: publicEvidenceItems(proposal.evidenceRefs, { ...options, runAgentId: proposal.proposedByAgentId }),
    beforeSummary: publicGoalContractSummary(proposal.beforeContract),
    afterSummary: publicGoalContractSummary(proposal.afterContract),
  };
}

export function publicGoalActivitySummary(
  activity: Pick<typeof goalActivities.$inferSelect, "activityKind" | "summary">,
) {
  if (hasTechnicalRunSummary(activity.summary)) return "The Agent shared an update that needs attention.";
  const summary = publicGoalText(activity.summary);
  if (activity.activityKind !== "closeout") return summary;
  const legacyOutcome = /^Goal evaluated as\s+(.+)$/i.exec(summary)?.[1]?.trim();
  return legacyOutcome ? publicGoalOutcome(legacyOutcome) : summary;
}

export function publicGoalResultProposal(
  proposal: typeof goalResultProposals.$inferSelect,
  options: PublicEvidenceOptions = {},
): PublicGoalResultProposal {
  const preflight = publicGoalRecord(proposal.preflight);
  const candidate = publicGoalRecord(proposal.candidate);
  const outcome = typeof preflight.outcome === "string" ? preflight.outcome : "inconclusive";
  const resultValue = preflight.resultValue ?? candidate.resultValue;
  const decision = typeof preflight.decision === "string"
    ? preflight.decision
    : typeof candidate.decision === "string" ? candidate.decision : null;
  const criteria = Array.isArray(preflight.criteria)
    ? preflight.criteria.flatMap((criterion) => {
      const record = publicGoalRecord(criterion);
      const id = typeof record.id === "string" && record.id.trim() ? record.id : null;
      const status = typeof record.status === "string" ? record.status : "unknown";
      if (!id) return [];
      return [{
        id,
        status,
        missingEvidenceCount: Array.isArray(record.missingEvidence) ? record.missingEvidence.length : 0,
      }];
    })
    : [];
  return {
    id: proposal.id,
    status: proposal.status,
    outcome,
    outcomeLabel: outcome === "completed_with_result" && resultValue !== undefined
      ? `Completed with result: ${String(resultValue)}`
      : outcome === "decided" && decision
        ? `Decision reached: ${decision}`
        : publicGoalOutcome(outcome),
    criteria,
    evidence: publicEvidenceItems(candidate.evidenceRefs, { ...options, runAgentId: proposal.proposedByAgentId }),
    riskSummary: proposal.riskSummary ? publicGoalText(proposal.riskSummary) : proposal.riskSummary,
  };
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

const PROVIDER_RESULT_ENVELOPE_PATTERN = /__RUDDER_RESULT_[a-z0-9-]+__/i;

function publicProviderSummary(value: string) {
  const envelope = PROVIDER_RESULT_ENVELOPE_PATTERN.exec(value);
  if (!envelope) return value;
  const payloadText = value.slice(envelope.index + envelope[0].length).trim();
  try {
    const payload = JSON.parse(payloadText) as Record<string, unknown>;
    if (typeof payload.body === "string" && payload.body.trim()) return payload.body.trim();
  } catch {
    // Keep the visible text before a malformed internal envelope.
  }
  return value.slice(0, envelope.index).trim() || value;
}

const TECHNICAL_RUN_SUMMARY_PATTERNS = [
  /(?:failed query|stack trace|traceback|drizzlequeryerror|connection ended|node_modules|\b(?:ECONN|ENOTFOUND|ETIMEDOUT)\b)/i,
  /(?:^|\s)(?:error|exception):/i,
  /\bat\s+[\w./-]+:\d+(?::\d+)?/i,
  /(?:process adapter|missing command|adapter failure)/i,
];

function hasTechnicalRunSummary(value: string) {
  return TECHNICAL_RUN_SUMMARY_PATTERNS.some((pattern) => pattern.test(value));
}

export function publicRunSummary(run: {
  status: string;
  resultJson: Record<string, unknown> | null;
  resultSummaryJson: Record<string, unknown> | null;
  error: string | null;
}) {
  const rawSummary = publicProviderSummary(resultSummary(run));
  if (hasTechnicalRunSummary(rawSummary)) {
    if (["queued", "pending", "running", "started"].includes(run.status)) {
      return "The Agent is working on this Goal.";
    }
    if (["succeeded", "completed"].includes(run.status)) {
      return "The Agent completed its latest action.";
    }
    if (run.status === "failed") return "The Agent could not complete its latest action.";
    if (["cancelled", "canceled"].includes(run.status)) return "The Agent stopped its latest action.";
    if (["timed_out", "timeout"].includes(run.status)) return "The Agent's latest action needs attention.";
    return "The Agent has a new update on this Goal.";
  }
  const internalRunPrefix = rawSummary.match(/^Agent run\s+[\w-]+\s+is\s+[^:]+(?::\s*(.+))?$/i);
  if (internalRunPrefix) {
    const detail = internalRunPrefix[1]?.trim();
    if (detail && ["succeeded", "completed"].includes(run.status)) return publicGoalText(detail);
    if (["queued", "pending", "running", "started"].includes(run.status)) return "The Agent is working on this Goal.";
    if (["succeeded", "completed"].includes(run.status)) return "The Agent completed its latest action.";
    if (run.status === "failed") return "The Agent could not complete its latest action.";
    if (["cancelled", "canceled"].includes(run.status)) return "The Agent stopped its latest action.";
    if (["timed_out", "timeout"].includes(run.status)) return "The Agent's latest action needs attention.";
    return "The Agent has a new update on this Goal.";
  }
  const summary = publicGoalText(rawSummary);
  const detailAfterInternalPrefix = summary.match(/^Agent run\s+[\w-]+\s+is\s+[^:]+:\s*(.+)$/i)?.[1]?.trim();
  if (detailAfterInternalPrefix) return detailAfterInternalPrefix;
  if (!/\bagent\s+run\b/i.test(summary)) return summary;
  if (["queued", "pending", "running", "started"].includes(run.status)) {
    return "The Agent is working on this Goal.";
  }
  if (["succeeded", "completed"].includes(run.status)) {
    return "The Agent completed its latest action.";
  }
  if (run.status === "failed") return "The Agent could not complete its latest action.";
  if (["cancelled", "canceled"].includes(run.status)) return "The Agent stopped its latest action.";
  if (["timed_out", "timeout"].includes(run.status)) return "The Agent's latest action needs attention.";
  return "The Agent has a new update on this Goal.";
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
      blockers: [{
        code: "outcome_required",
        field: "goal",
        message: "Describe the result or decision someone should be able to verify. Include what changes and, when useful, a measure or deadline.",
      }],
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
      blockers: [{
        code: "owner_required",
        field: "ownerAgentId",
        message: "Select an available Agent from this organization to own and start the Goal.",
      }],
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
    ? `We will know it worked when ${title} and this context is satisfied: ${context}`
    : mode === "decide"
      ? `A documented decision resolves: ${title}`
      : mode === "maximize"
        ? `Progress is measured toward: ${title}`
        : mode === "maintain"
          ? `The condition remains true: ${title}`
          : `A reviewable result shows that ${title}`;
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
        summary: firstAction,
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
    blockers: [],
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
    externalWorkFact: Pick<ExternalGoalWorkFact, "runStatus"> | null = null,
  ) {
    if (goal.lifecycle === "closed") return "closed" as const;
    if (goal.lifecycle === "draft") return "needs_attention" as const;
    if (readyResult) return "ready_for_acceptance" as const;
    if (pendingChange) return "needs_attention" as const;
    if (pendingWakeup?.status === "deferred_goal_focus") return "waiting_focus" as const;
    if (pendingWakeup?.status === "deferred_goal_blocked"
      || pendingWakeup?.status === "deferred_agent_paused") return "needs_attention" as const;
    if (goalRunAttentionReason(externalWorkFact?.runStatus)) return "needs_attention" as const;
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

  async function cancelPendingGoalContinuationWakes(database: Database, goalId: string, reason: string) {
    const pending = await database.select({
      id: agentWakeupRequests.id,
      runId: agentWakeupRequests.runId,
    }).from(agentWakeupRequests).where(and(
      sql`${agentWakeupRequests.payload} ->> 'goalId' = ${goalId}`,
      eq(agentWakeupRequests.reason, "goal_continuation"),
      inArray(agentWakeupRequests.status, ["queued", "deferred_goal_focus", "deferred_agent_paused", "deferred_goal_blocked"]),
    ));
    if (pending.length === 0) return;
    const now = new Date();
    for (const wake of pending) {
      if (wake.runId) {
        await database.update(heartbeatRuns).set({
          status: "cancelled",
          finishedAt: now,
          error: reason,
          errorCode: "goal.result_proposal_ready",
          updatedAt: now,
        }).where(and(
          eq(heartbeatRuns.id, wake.runId),
          eq(heartbeatRuns.status, "queued"),
        ));
      }
      await database.update(agentWakeupRequests).set({
        status: "cancelled",
        finishedAt: now,
        error: reason,
        updatedAt: now,
      }).where(and(
        eq(agentWakeupRequests.id, wake.id),
        inArray(agentWakeupRequests.status, ["queued", "deferred_goal_focus", "deferred_agent_paused", "deferred_goal_blocked"]),
      ));
    }
  }

  async function ensureGoalWakeupIntent(
    database: Database,
    goal: GoalRow,
    input: {
      event: "goal_started" | "goal_feedback" | "goal_change_decided" | "goal_continuation";
      eventId: string;
      actor: GoalWakeupActor;
      feedback?: { id: string; body: string; kind: string };
      decision?: { decision: "approve" | "reject"; note: string | null; status: string };
      continuation?: {
        kind: "commitment" | "verification";
        summary: string;
        wakeCondition?: string | null;
        planRevision: number;
      };
    },
  ): Promise<GoalWakeupDispatch> {
    if (!goal.ownerAgentId) throw conflict("Goal has no Owner Agent to wake");
    const currentPlan = goal.planRevision > 0
      ? await database.select().from(goalPlans).where(and(
          eq(goalPlans.goalId, goal.id),
          eq(goalPlans.revision, goal.planRevision),
        )).then((rows) => rows[0] ?? null)
      : null;
    const latestCheckpoint = await database.select().from(goalCheckpoints).where(eq(
      goalCheckpoints.goalId,
      goal.id,
    )).orderBy(desc(goalCheckpoints.createdAt)).limit(1).then((rows) => rows[0] ?? null);
    const taskKey = `goal:${goal.id}:${input.event}:${input.eventId}`;
    const idempotencyKey = input.event === "goal_started"
      ? `goal-start:${input.eventId}`
      : input.event === "goal_feedback"
        ? `goal-feedback:${input.eventId}`
        : input.event === "goal_change_decided"
          ? `goal-change-decision:${input.eventId}:${input.decision?.decision ?? "unknown"}`
          : `goal-continuation:${input.eventId}`;
    const payload: Record<string, unknown> = {
      event: input.event,
      goalId: goal.id,
      taskKey,
      ...(input.event === "goal_started" ? { goalStartRequestId: input.eventId } : {}),
      ...(input.feedback ? { feedbackId: input.feedback.id } : {}),
      ...(input.decision ? { goalChangeProposalId: input.eventId, decision: input.decision.decision } : {}),
      ...(input.continuation ? {
        checkpointId: input.eventId,
        planRevision: input.continuation.planRevision,
        continuation: {
          kind: input.continuation.kind,
          summary: input.continuation.summary,
          wakeCondition: input.continuation.wakeCondition ?? null,
        },
      } : {}),
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
      goalPlan: currentPlan
        ? {
            revision: currentPlan.revision,
            summary: currentPlan.summary,
            hypotheses: currentPlan.hypotheses,
            selectedPaths: currentPlan.selectedPaths,
            rejectedPaths: currentPlan.rejectedPaths,
            sequencing: currentPlan.sequencing,
            budgetAllocations: currentPlan.budgetAllocations,
            invalidationConditions: currentPlan.invalidationConditions,
          }
        : null,
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
      ...(latestCheckpoint ? {
        goalCheckpoint: {
          id: latestCheckpoint.id,
          summary: latestCheckpoint.summary,
          evidenceRefs: latestCheckpoint.evidenceRefs,
          planRevisionBefore: latestCheckpoint.planRevisionBefore,
          planRevisionAfter: latestCheckpoint.planRevisionAfter,
          continuationWakeupRequestId: latestCheckpoint.continuationWakeupRequestId,
          continuation: {
            kind: latestCheckpoint.continuationKind,
            summary: latestCheckpoint.continuationSummary,
            wakeCondition: latestCheckpoint.wakeCondition,
          },
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
        summary: publicRunSummary(run),
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
        summary: publicRunSummary(run),
        occurredAt: run.updatedAt,
        sourceId: run.id,
        sourceRunId: run.id,
        runStatus: run.status,
        evidenceRefs: [],
      }));
    // Run facts use a public, namespaced source id while retaining the raw run id
    // separately for evidence links and attention actions.
    const allRunFacts = [...relatedFacts, ...directFacts].filter((fact) => fact.id.startsWith("work-status:run:"));
    const activeRunFacts = allRunFacts.filter((fact) => fact.runStatus && !TERMINAL_RUN_STATUSES.includes(fact.runStatus as typeof TERMINAL_RUN_STATUSES[number]));
    if (activeRunFacts.length > 0) {
      return activeRunFacts.sort((left, right) => {
        const timeDelta = right.occurredAt.getTime() - left.occurredAt.getTime();
        return timeDelta !== 0 ? timeDelta : right.id.localeCompare(left.id);
      })[0] ?? null;
    }
    const terminalRunFacts = allRunFacts.filter((fact) => (
      fact.runStatus && TERMINAL_RUN_STATUSES.includes(fact.runStatus as typeof TERMINAL_RUN_STATUSES[number])
    ));
    if (terminalRunFacts.length > 0) {
      const preferredTerminal = preferredRunId
        ? terminalRunFacts.find((fact) => fact.sourceRunId === preferredRunId) ?? null
        : null;
      const latestTerminal = terminalRunFacts.sort((left, right) => {
        const timeDelta = right.occurredAt.getTime() - left.occurredAt.getTime();
        return timeDelta !== 0 ? timeDelta : right.id.localeCompare(left.id);
      })[0] ?? null;
      // Preserve the Run attached to the current evidence. A newer failed,
      // cancelled, or timed-out Run still takes priority because it needs
      // human attention; a generic successful Run must not hide the checkpoint
      // the user is currently inspecting.
      if (preferredTerminal) {
        const latestNeedsAttention = latestTerminal?.runStatus === "failed"
          || latestTerminal?.runStatus === "cancelled"
          || latestTerminal?.runStatus === "canceled"
          || latestTerminal?.runStatus === "timed_out"
          || latestTerminal?.runStatus === "timeout";
        if (!latestNeedsAttention || preferredTerminal.occurredAt >= latestTerminal!.occurredAt) {
          return preferredTerminal;
        }
      }
      return latestTerminal;
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
    const orgUrlKey = await organizationUrlKey(db, goal.orgId);
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
          evidence: publicEvidenceItems(activity.evidenceRefs, {
            orgUrlKey,
            runAgentId: activity.submittedByAgentId,
          }),
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
        evidence: [],
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
        summary: publicGoalText(proposal.rationale),
        createdAt: proposal.createdAt,
        evidence: publicEvidenceItems(proposal.evidenceRefs, {
          orgUrlKey,
          runAgentId: proposal.proposedByAgentId,
        }),
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
        summary: publicGoalText(`${publicGoalOutcome(proposal.preflight.outcome)}. ${proposal.riskSummary}`),
        createdAt: proposal.createdAt,
        evidence: publicEvidenceItems(proposal.candidate.evidenceRefs, {
          orgUrlKey,
          runAgentId: proposal.proposedByAgentId,
        }),
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
    const orgUrlKey = await organizationUrlKey(db, goal.orgId);
    const [historyPage, changes, results, evidenceActivity, pendingWakeup] = await Promise.all([
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
        evidence: publicEvidenceItems(evidenceActivity.evidenceRefs, {
          orgUrlKey,
          runAgentId: evidenceActivity.submittedByAgentId,
        }),
      }
      : null;
    const pendingChange = changes[0] ?? null;
    const readyResult = results.find((proposal) => proposal.status === "ready") ?? null;
    const runAttentionReason = goalRunAttentionReason(externalWorkFact?.runStatus);
    const facet = facetFor(goal, pendingChange, readyResult, pendingWakeup, externalWorkFact);
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
            reason: publicGoalText(pendingChange.rationale),
            sourceId: pendingChange.id,
          }
            : goal.lifecycle === "draft" && goal.alignmentQuestion
            ? { kind: "alignment_question" as const, reason: publicGoalText(goal.alignmentQuestion), sourceId: goal.id }
            : wakeupAttentionReason
              ? { kind: "owner_blocked" as const, reason: wakeupAttentionReason, sourceId: pendingWakeup?.status ?? null }
              : runAttentionReason
                ? { kind: "owner_blocked" as const, reason: runAttentionReason, sourceId: externalWorkFact?.sourceRunId ?? externalWorkFact?.sourceId ?? null }
                : null;
    const publicGoal = publicGoalView(goal);
    return {
      goal: publicGoal,
      facet,
      currentGoal: { summary: publicGoal.outcomeStatement ?? goal.title, updatedFromEvidence: Boolean(progressSource) },
      currentProgress: progressSource
        ? {
          summary: progressSource.summary,
          sourceActivityId: progressSource.sourceActivityId,
          evidence: progressSource.evidence,
        }
        : {
          summary: "No evidence-backed progress has been recorded yet.",
          sourceActivityId: null,
          evidence: [],
        },
      agentAction: readyResult
        ? null
        : externalWorkFact
        ? {
          summary: externalWorkFact.summary,
          sourceIds: [externalWorkFact.sourceId],
          ...(externalWorkFact.runStatus ? { status: externalWorkFact.runStatus } : {}),
        }
        : null,
      nextStep: readyResult
        ? { summary: "Review the proposed result above.", wakeCondition: null }
        : pendingChange
          ? { summary: "Review the proposed Goal update above.", wakeCondition: null }
          : goal.continuationKind && goal.continuationSummary
            ? {
              summary: publicGoalText(goal.continuationSummary),
              wakeCondition: goal.wakeCondition ? publicGoalText(goal.wakeCondition) : null,
            }
            : null,
      attention,
      timeline: historyPage.items,
      timelineNextCursor: historyPage.nextCursor,
      changeProposals: changes.map((proposal) => publicGoalChangeProposal(proposal, { orgUrlKey })),
      resultProposals: results.map((proposal) => publicGoalResultProposal(proposal, { orgUrlKey })),
    };
  }

  return {
    list: (orgId: string) => db.select().from(goals).where(eq(goals.orgId, orgId)).orderBy(asc(goals.createdAt)),

    getById: (id: string) => db.select().from(goals).where(eq(goals.id, id)).then((rows) => rows[0] ?? null),

    resolveByReference: async (orgId: string, reference: string) => {
      const parsed = parseShortRef(reference);
      if (parsed?.kind !== "goal") return { goal: null, ambiguous: false } as const;
      const rows = await db.select().from(goals).where(eq(goals.orgId, orgId));
      const matches = rows.filter((row) => row.id.replaceAll("-", "").toLowerCase().startsWith(parsed.prefix));
      return {
        goal: matches.length === 1 ? matches[0]! : null,
        ambiguous: matches.length > 1,
      } as const;
    },

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
          summary: publicGoalText(`The Agent is starting with: ${activation.initialContinuation.summary}`),
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
        const [progress, pendingChange, readyResult, owner, pendingWakeup, externalWorkFact] = await Promise.all([
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
          latestExternalWorkFact(goal),
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
              ?? goalWakeupAttentionReason(pendingWakeup)
              ?? goalRunAttentionReason(externalWorkFact?.runStatus);
        return {
          id: goal.id,
          orgId: goal.orgId,
          title: goal.title,
          lifecycle: goal.lifecycle,
          status: goal.status,
          facet: facetFor(goal, pendingChange, readyResult, pendingWakeup, externalWorkFact),
          ownerAgentId: goal.ownerAgentId,
          ownerName: owner?.name ?? null,
          currentProgress,
          progressSummary: currentProgress,
          nextAction: goal.continuationSummary ? publicGoalText(goal.continuationSummary) : null,
          nextStepSummary: goal.continuationSummary
            ? publicGoalText(goal.continuationSummary)
            : "No next step has been recorded.",
          targetTime: goal.evaluationDeadline ?? goal.actionDeadline,
          attentionReason: attentionReason ? publicGoalText(attentionReason) : null,
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

    latestCheckpoint: async (id: string) => db.select().from(goalCheckpoints)
      .where(eq(goalCheckpoints.goalId, id))
      .orderBy(desc(goalCheckpoints.createdAt)).limit(1)
      .then((rows) => rows[0] ?? null),

    recentCheckpoints: async (id: string) => db.select().from(goalCheckpoints)
      .where(eq(goalCheckpoints.goalId, id))
      .orderBy(desc(goalCheckpoints.createdAt)).limit(3),

    pendingContinuationWake: async (id: string) => db.select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      payload: agentWakeupRequests.payload,
    }).from(agentWakeupRequests).where(and(
      sql`${agentWakeupRequests.payload} ->> 'goalId' = ${id}`,
      eq(agentWakeupRequests.reason, "goal_continuation"),
      inArray(agentWakeupRequests.status, ["queued", "deferred_goal_focus", "deferred_agent_paused", "deferred_goal_blocked"]),
      isNull(agentWakeupRequests.runId),
    )).orderBy(desc(agentWakeupRequests.requestedAt)).limit(1)
      .then((rows) => {
        const row = rows[0];
        if (!row) return null;
        const payload = publicGoalRecord(row.payload);
        const continuation = publicGoalRecord(payload.continuation);
        return {
          id: row.id,
          status: row.status,
          planRevision: typeof payload.planRevision === "number" ? payload.planRevision : null,
          checkpointId: typeof payload.checkpointId === "string" ? payload.checkpointId : null,
          continuation,
        };
      }),

    create: async (orgId: string, data: {
      title: string;
      description?: string | null;
      alignmentQuestion?: string | null;
      ownerAgentId?: string | null;
      ownerAgentRuntimeOverrides?: IssueAssigneeAgentRuntimeOverrides | null;
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
        ownerAgentRuntimeOverrides: data.ownerAgentRuntimeOverrides ?? null,
      }).returning().then((rows) => rows[0]);
    },

    update: async (id: string, data: {
      title?: string;
      description?: string | null;
      alignmentQuestion?: string | null;
      ownerAgentId?: string | null;
      ownerAgentRuntimeOverrides?: IssueAssigneeAgentRuntimeOverrides | null;
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
        const { title, description, alignmentQuestion, ownerAgentId, ownerAgentRuntimeOverrides, targetTime } = data;
        const ownerChanged = ownerAgentId !== undefined && ownerAgentId !== current.ownerAgentId;
        const changedGoal = await database.update(goals).set({
          title,
          description,
          alignmentQuestion,
          ...(ownerAgentId !== undefined ? { ownerAgentId } : {}),
          ...(ownerAgentRuntimeOverrides !== undefined
            ? { ownerAgentRuntimeOverrides }
            : ownerChanged
              ? { ownerAgentRuntimeOverrides: null }
              : {}),
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
          summary: publicGoalText(`The Agent is starting with: ${input.initialContinuation.summary}`),
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

    checkpoint: async (
      id: string,
      input: GoalCheckpointInput,
      actorAgentId: string | null,
      actorRunId: string | null,
    ) => {
      if (!actorAgentId) throw forbidden("Only the Goal Owner Agent can create a checkpoint");
      if (!actorRunId) throw unprocessable("Goal checkpoint must be attributed to the current Run");
      const inputHash = stableGoalHash({
        summary: input.summary,
        evidenceRefs: input.evidenceRefs,
        expectedPlanRevision: input.expectedPlanRevision,
        plan: input.plan ?? null,
        continuation: input.continuation,
      });
      return db.transaction(async (tx) => {
        const database = tx as unknown as Database;
        const current = await requireGoalForUpdate(database, id);
        assertCanonicalActiveGoal(current);
        assertGoalOwner(current, actorAgentId);
        const run = await requireGoalRun(database, current, actorRunId, actorAgentId);
        const existing = await database.select().from(goalCheckpoints).where(and(
          eq(goalCheckpoints.goalId, id),
          eq(goalCheckpoints.idempotencyKey, input.idempotencyKey),
        )).then((rows) => rows[0] ?? null);
        if (existing) {
          if (existing.runId !== actorRunId) {
            throw conflict("Goal checkpoint idempotency key belongs to a different Run");
          }
          if (existing.inputHash !== inputHash) {
            throw conflict("Goal checkpoint idempotency key was reused with a different payload");
          }
          return { checkpoint: existing, dispatch: null };
        }
        if (run.status !== "running") {
          throw conflict("Goal checkpoint must be attributed to the current running Run");
        }
        const readyProposal = await database.select({ id: goalResultProposals.id }).from(goalResultProposals).where(and(
          eq(goalResultProposals.goalId, id),
          eq(goalResultProposals.status, "ready"),
        )).limit(1).then((rows) => rows[0] ?? null);
        if (readyProposal) throw conflict("Goal already has a Result Proposal ready for review");
        if (current.planRevision !== input.expectedPlanRevision) {
          throw conflict("Goal Plan changed before checkpoint", {
            expectedPlanRevision: input.expectedPlanRevision,
            currentPlanRevision: current.planRevision,
          });
        }
        const nextPlanRevision = input.plan ? current.planRevision + 1 : current.planRevision;
        if (input.plan) {
          await database.insert(goalPlans).values({
            orgId: current.orgId,
            goalId: current.id,
            revision: nextPlanRevision,
            ...input.plan,
            createdByAgentId: actorAgentId,
          });
        }
        const now = new Date();
        const changedGoal = await database.update(goals).set({
          planRevision: nextPlanRevision,
          continuationKind: input.continuation.kind,
          continuationSummary: input.continuation.summary,
          wakeCondition: input.continuation.wakeCondition ?? null,
          updatedAt: now,
        }).where(and(
          eq(goals.id, id),
          eq(goals.orgId, current.orgId),
          eq(goals.lifecycle, "active"),
          eq(goals.planRevision, input.expectedPlanRevision),
        )).returning().then((rows) => rows[0] ?? null);
        if (!changedGoal) throw conflict("Goal changed before checkpoint could be committed");
        const [checkpoint] = await database.insert(goalCheckpoints).values({
          orgId: current.orgId,
          goalId: current.id,
          runId: actorRunId,
          ownerAgentId: current.ownerAgentId!,
          submittedByAgentId: actorAgentId,
          inputHash,
          idempotencyKey: input.idempotencyKey,
          summary: input.summary,
          evidenceRefs: input.evidenceRefs,
          planPayload: input.plan ? { ...input.plan } : null,
          planRevisionBefore: current.planRevision,
          planRevisionAfter: nextPlanRevision,
          continuationKind: input.continuation.kind,
          continuationSummary: input.continuation.summary,
          wakeCondition: input.continuation.wakeCondition ?? null,
        }).returning();
        if (!checkpoint) throw conflict("Goal checkpoint could not be recorded");
        await database.insert(goalActivities).values({
          orgId: current.orgId,
          goalId: current.id,
          contractRevision: current.contractRevision,
          submittedByAgentId: actorAgentId,
          agentOwnerRefAtTime: current.ownerAgentId,
          activityKind: "checkpoint",
          runRef: actorRunId,
          summary: input.summary,
          evidenceRefs: input.evidenceRefs,
          idempotencyKey: `goal-checkpoint:${input.idempotencyKey}`,
          occurredAt: now,
        }).onConflictDoNothing();
        let dispatch: GoalWakeupDispatch | null = null;
        if (input.continuation.kind === "commitment" || input.continuation.kind === "verification") {
          dispatch = await ensureGoalWakeupIntent(database, changedGoal, {
            event: "goal_continuation",
            eventId: checkpoint.id,
            actor: { actorType: "agent", actorId: actorAgentId },
            continuation: {
              kind: input.continuation.kind,
              summary: input.continuation.summary,
              wakeCondition: input.continuation.wakeCondition ?? null,
              planRevision: nextPlanRevision,
            },
          });
          const updated = await database.update(goalCheckpoints).set({ continuationWakeupRequestId: dispatch.wakeupRequestId })
            .where(eq(goalCheckpoints.id, checkpoint.id)).returning().then((rows) => rows[0] ?? null);
          if (updated) return { checkpoint: updated, dispatch };
        }
        return { checkpoint, dispatch };
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
        // Heartbeat claims hold the Owner Agent row before Goal and Run rows;
        // take the same lock first so Result Proposal cancellation cannot
        // deadlock on heartbeat_runs.agent_id foreign-key checks.
        await database.select({ id: agents.id }).from(agents)
          .where(eq(agents.id, actorAgentId)).for("update");
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
          await cancelPendingGoalContinuationWakes(
            database,
            id,
            "Cancelled because a Goal Result Proposal is ready for human Acceptance",
          );
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
        const changedGoal = await database.update(goals).set({ ownerAgentId: input.agentId, ownerAgentRuntimeOverrides: null, updatedAt: now })
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
