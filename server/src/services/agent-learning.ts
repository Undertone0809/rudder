import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import {
  agents,
  feedbackBatches,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  learningCandidates,
  organizationSkillRevisions,
  organizationSkills as organizationSkillsTable,
  runFeedbackItems,
  runFeedbackSessions,
  runLoadedSkillRevisions,
  skillEvaluationReports,
  skillEvidenceLinks,
  skillUpdateProposals,
} from "@rudderhq/db";
import type {
  AgentLearningSummary,
  ApplyApprovedLearningResponse,
  CreateRunFeedbackItemRequest,
  CreateRunFeedbackSessionRequest,
  FeedbackBatch,
  FeedbackBatchReview,
  LearningCandidate,
  LearningCandidateClassification,
  LearningRiskLevel,
  RunFeedbackSession,
  RunLoadedSkillsSummary,
  SkillUpdateProposal,
  SubmitRunFeedbackSessionResponse,
  UpdateLearningCandidateRequest,
} from "@rudderhq/shared";
import { notFound, unprocessable } from "../errors.js";
import { parseObject } from "../agent-runtimes/utils.js";
import { deriveAgentUrlKey } from "@rudderhq/shared";
import { agentService } from "./agents.js";
import { logActivity } from "./activity-log.js";
import { organizationSkillService } from "./organization-skills.js";

type LearningActor = {
  actorType: "user" | "agent";
  actorId: string;
  agentId: string | null;
  runId: string | null;
};

type CandidateDraft = {
  title: string;
  instruction: string;
  appliesWhenJson: Record<string, unknown>;
  mustNot: string | null;
  targetSkillReason: string;
  classification: LearningCandidateClassification;
  confidence: "low" | "medium" | "high";
  riskLevel: LearningRiskLevel;
  validationChecksJson: string[];
};

type SkillLearning = {
  id: string;
  title: string;
  instruction: string;
  appliesWhenJson: Record<string, unknown>;
  mustNot: string | null;
  validationChecksJson: string[];
};

const ORGANIZATION_SELECTION_PREFIX = "org:";
const BUNDLED_SELECTION_PREFIX = "bundled:";

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function compactText(value: string, maxLength = 160) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function firstSentence(value: string) {
  const normalized = compactText(value, 120);
  const match = normalized.match(/^(.+?[.!?。！？])(?:\s|$)/);
  return compactText(match?.[1] ?? normalized, 96);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function quoteYaml(value: string) {
  return JSON.stringify(value);
}

function renderAppliesWhen(value: Record<string, unknown>) {
  const entries = Object.entries(value)
    .map(([key, item]) => `${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`)
    .join(", ");
  return entries || "similar future work";
}

function normalizeSkillSlug(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "agent-learning";
}

function runtimeSkillLookupKeys(skillKey: string) {
  const trimmed = skillKey.trim();
  if (!trimmed) return [];

  const keys = new Set([trimmed]);
  if (trimmed.startsWith(ORGANIZATION_SELECTION_PREFIX)) {
    const orgKey = trimmed.slice(ORGANIZATION_SELECTION_PREFIX.length).trim();
    if (orgKey) keys.add(orgKey);
  }
  if (trimmed.startsWith(BUNDLED_SELECTION_PREFIX)) {
    const bundledKey = trimmed.slice(BUNDLED_SELECTION_PREFIX.length).trim();
    if (bundledKey) keys.add(bundledKey);
  }
  return Array.from(keys);
}

function buildRuntimeSkillMap(skills: Array<typeof organizationSkillsTable.$inferSelect>) {
  const byRuntimeKey = new Map<string, typeof organizationSkillsTable.$inferSelect>();
  for (const skill of skills) {
    byRuntimeKey.set(skill.key, skill);
    byRuntimeKey.set(`${ORGANIZATION_SELECTION_PREFIX}${skill.key}`, skill);
    byRuntimeKey.set(`${BUNDLED_SELECTION_PREFIX}${skill.key}`, skill);
  }
  return byRuntimeKey;
}

function managedLearningSkillSlug(agent: { id: string; name: string; urlKey?: string | null }) {
  const key = agent.urlKey?.trim() || deriveAgentUrlKey(agent.name) || agent.id.slice(0, 8);
  return normalizeSkillSlug(`agent-learning-${key}`);
}

function buildManagedSkillMarkdown(agent: { name: string }) {
  const name = `Agent Learning - ${agent.name}`;
  const description = `Approved learnings from real run feedback for ${agent.name}. Use these as durable working habits in future runs.`;
  return [
    "---",
    `name: ${quoteYaml(name)}`,
    `description: ${quoteYaml(description)}`,
    "---",
    "",
    `# ${name}`,
    "",
    "This skill contains approved learnings from run feedback. Apply these rules when the current task matches their scope.",
    "",
    "## Active Learnings",
    "",
    "No approved learnings yet.",
    "",
  ].join("\n");
}

function appendLearningsToSkillMarkdown(input: {
  markdown: string;
  batchId: string;
  candidateLearnings: SkillLearning[];
}) {
  const existing = input.markdown.trimEnd();
  const sectionHeader = "## Active Learnings";
  const hasSection = existing.includes(sectionHeader);
  const base = hasSection
    ? existing.replace(/\nNo approved learnings yet\.\s*$/m, "")
    : `${existing}\n\n${sectionHeader}\n`;
  const additions = input.candidateLearnings
    .filter((learning) => !base.includes(`rudder-learning:${learning.id}`))
    .map((learning) => [
      `<!-- rudder-learning:${learning.id} -->`,
      `### ${learning.title}`,
      "",
      `- Instruction: ${learning.instruction}`,
      `- Applies when: ${renderAppliesWhen(learning.appliesWhenJson)}`,
      ...(learning.mustNot ? [`- Must not: ${learning.mustNot}`] : []),
      `- Source: feedback batch ${input.batchId}`,
      ...(learning.validationChecksJson.length > 0
        ? ["- Validation checks:", ...learning.validationChecksJson.map((check) => `  - ${check}`)]
        : []),
      "",
    ].join("\n"));

  if (additions.length === 0) return `${base.trimEnd()}\n`;
  return `${base.trimEnd()}\n\n${additions.join("\n")}`.trimEnd() + "\n";
}

function parseLearningCandidatesFromStructuredSpec(value: unknown): Array<{ title: string; instruction: string }> {
  const record = isPlainRecord(value) ? value : {};
  const learnings = Array.isArray(record.activeLearnings) ? record.activeLearnings : [];
  return learnings.flatMap((entry) => {
    if (!isPlainRecord(entry)) return [];
    const title = readString(entry.title);
    const instruction = readString(entry.instruction);
    return title && instruction ? [{ title, instruction }] : [];
  });
}

function classifyFeedback(body: string): LearningCandidateClassification {
  const lower = body.toLowerCase();
  if (/[?？]/.test(body) || lower.includes("not sure") || lower.includes("unclear")) return "open_question";
  if (lower.includes("conflict") || lower.includes("contradict")) return "conflicting_signal";
  if (
    lower.includes("one-off") ||
    lower.includes("this run") ||
    lower.includes("this issue") ||
    lower.includes("this time") ||
    body.includes("这次") ||
    body.includes("这条")
  ) {
    return "one_off_correction";
  }
  if (
    lower.includes("for this repo") ||
    lower.includes("for this project") ||
    lower.includes("my preference") ||
    lower.includes("prefer") ||
    body.includes("这个项目")
  ) {
    return "contextual_preference";
  }
  return "core_behavior";
}

function generateCandidateDraft(item: { body: string }): CandidateDraft {
  const body = item.body.trim();
  const lower = body.toLowerCase();
  const classification = classifyFeedback(body);
  const riskLevel: LearningRiskLevel =
    classification === "core_behavior" ? "low" : classification === "contextual_preference" ? "medium" : "high";
  const confidence = classification === "core_behavior" ? "medium" : "low";

  if (
    lower.includes("agents.md") ||
    (lower.includes("read") && (lower.includes("before editing") || lower.includes("before changing"))) ||
    body.includes("项目说明")
  ) {
    return {
      title: "Read project instructions before editing",
      instruction:
        "Before editing code or project artifacts, read the repository-level AGENTS.md and any task-specific project instructions, then carry those conventions into the implementation.",
      appliesWhenJson: { taskKind: "coding", runPhase: "before_editing" },
      mustNot: "Do not start code changes before checking the available project instructions unless the task is explicitly non-code.",
      targetSkillReason: "This is a durable coding and project-convention habit.",
      classification,
      confidence,
      riskLevel,
      validationChecksJson: [
        "Run timeline shows project instructions or AGENTS.md were read before the first edit.",
        "Final output reflects relevant project conventions when they affect the task.",
      ],
    };
  }

  if (
    lower.includes("closeout") ||
    lower.includes("ending") ||
    lower.includes("before ending") ||
    lower.includes("handoff") ||
    lower.includes("blocked") ||
    body.includes("收尾") ||
    body.includes("结束")
  ) {
    return {
      title: "Leave a clear closeout status",
      instruction:
        "Before ending a run, leave one clear result state: done, blocked, handoff, or needs review. If blocked or handing off, include the blocker, attempted work, owner, and next action.",
      appliesWhenJson: { runPhase: "closeout" },
      mustNot: "Do not end an incomplete task with only a vague status or no next action.",
      targetSkillReason: "This belongs in the agent's issue execution and handoff behavior.",
      classification,
      confidence,
      riskLevel,
      validationChecksJson: [
        "Final output includes a done, blocked, handoff, or needs review status.",
        "Blocked or handoff runs include attempted work and next action.",
      ],
    };
  }

  if (
    lower.includes("issue goal") ||
    lower.includes("issue status") ||
    lower.includes("assignee") ||
    lower.includes("blocker") ||
    lower.includes("confirm the issue") ||
    body.includes("需求") ||
    body.includes("状态")
  ) {
    return {
      title: "Confirm issue state before implementation",
      instruction:
        "Before starting issue implementation work, inspect the issue goal, current status, assignee, blockers, and relevant project context.",
      appliesWhenJson: { taskKind: "issue_work", runPhase: "startup" },
      mustNot: "Do not perform a large audit for tiny clarification-only tasks.",
      targetSkillReason: "This is a reusable issue execution startup habit.",
      classification,
      confidence,
      riskLevel,
      validationChecksJson: [
        "Run timeline shows issue context was inspected before implementation.",
        "The run identifies blockers or ambiguity before making changes when relevant.",
      ],
    };
  }

  if (
    lower.includes("test") ||
    lower.includes("verify") ||
    lower.includes("screenshot") ||
    lower.includes("e2e") ||
    body.includes("验证")
  ) {
    return {
      title: "Verify changes before handoff",
      instruction:
        "Before handing off a user-visible or workflow change, run the relevant verification and report exactly what passed or could not be run.",
      appliesWhenJson: { runPhase: "verification" },
      mustNot: "Do not claim a user-visible change is complete based only on code inspection.",
      targetSkillReason: "This is a durable quality habit for implementation work.",
      classification,
      confidence,
      riskLevel,
      validationChecksJson: [
        "Final output names the verification command or browser check that was run.",
        "Visible UI changes include a rendered inspection result.",
      ],
    };
  }

  const title = firstSentence(body).replace(/[.!?。！？]$/, "");
  return {
    title: compactText(title || "Apply reviewer feedback in future runs", 96),
    instruction: lower.startsWith("when ") || lower.startsWith("before ") || lower.startsWith("do ")
      ? body
      : `In future similar runs, ${body.charAt(0).toLowerCase()}${body.slice(1)}`,
    appliesWhenJson: { taskKind: "similar_work" },
    mustNot: classification === "one_off_correction" ? "Do not generalize this beyond the source run without more evidence." : null,
    targetSkillReason: "This is inferred from explicit run feedback.",
    classification,
    confidence,
    riskLevel,
    validationChecksJson: ["Future run output or timeline shows this feedback was addressed when applicable."],
  };
}

function buildBatchSummary(items: Array<{ body: string }>) {
  if (items.length === 1) return compactText(items[0]!.body, 180);
  return `${items.length} feedback items: ${compactText(items.map((item) => firstSentence(item.body)).join("; "), 220)}`;
}

function safePatchJson(candidates: SkillLearning[]) {
  return {
    operation: "add_active_learnings",
    learnings: candidates,
  };
}

function pickSkillPreview(skill: typeof organizationSkillsTable.$inferSelect | null) {
  if (!skill) return null;
  return {
    id: skill.id,
    key: skill.key,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
  };
}

function normalizeCandidatePatch(patch: UpdateLearningCandidateRequest): Partial<typeof learningCandidates.$inferInsert> {
  const next: Partial<typeof learningCandidates.$inferInsert> = {};
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.instruction !== undefined) next.instruction = patch.instruction;
  if (patch.appliesWhenJson !== undefined) next.appliesWhenJson = patch.appliesWhenJson;
  if (patch.mustNot !== undefined) next.mustNot = patch.mustNot;
  if (patch.targetSkillId !== undefined) next.targetSkillId = patch.targetSkillId;
  if (patch.classification !== undefined) next.classification = patch.classification;
  if (patch.riskLevel !== undefined) next.riskLevel = patch.riskLevel;
  if (patch.validationChecksJson !== undefined) next.validationChecksJson = patch.validationChecksJson;
  if (patch.status !== undefined) next.status = patch.status;
  next.updatedAt = new Date();
  return next;
}

export function agentLearningService(db: Db) {
  const agentsSvc = agentService(db);
  const organizationSkills = organizationSkillService(db);

  async function getAgentOrThrow(orgId: string, agentId: string) {
    const agent = await agentsSvc.getById(agentId);
    if (!agent || agent.orgId !== orgId) throw notFound("Agent not found");
    return agent;
  }

  async function getSkillOrThrow(orgId: string, skillId: string) {
    const skill = await db
      .select()
      .from(organizationSkillsTable)
      .where(and(eq(organizationSkillsTable.id, skillId), eq(organizationSkillsTable.orgId, orgId)))
      .then((rows) => rows[0] ?? null);
    if (!skill) throw notFound("Skill not found");
    return skill;
  }

  async function getSessionOrThrow(orgId: string, sessionId: string) {
    const session = await db
      .select()
      .from(runFeedbackSessions)
      .where(and(eq(runFeedbackSessions.id, sessionId), eq(runFeedbackSessions.orgId, orgId)))
      .then((rows) => rows[0] ?? null);
    if (!session) throw notFound("Feedback session not found");
    return session;
  }

  async function getBatchOrThrow(orgId: string, batchId: string) {
    const batch = await db
      .select()
      .from(feedbackBatches)
      .where(and(eq(feedbackBatches.id, batchId), eq(feedbackBatches.orgId, orgId)))
      .then((rows) => rows[0] ?? null);
    if (!batch) throw notFound("Feedback batch not found");
    return batch;
  }

  async function createSession(
    orgId: string,
    input: CreateRunFeedbackSessionRequest,
    actor: LearningActor,
  ) {
    await getAgentOrThrow(orgId, input.targetAgentId);
    if (input.targetSkillId) await getSkillOrThrow(orgId, input.targetSkillId);

    return db
      .insert(runFeedbackSessions)
      .values({
        orgId,
        targetAgentId: input.targetAgentId,
        targetSkillId: input.targetSkillId ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        createdByAgentId: actor.actorType === "agent" ? actor.agentId : null,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function addFeedbackItem(
    orgId: string,
    sessionId: string,
    input: CreateRunFeedbackItemRequest,
  ) {
    const session = await getSessionOrThrow(orgId, sessionId);
    if (session.status !== "draft") throw unprocessable("Feedback session is already submitted");

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.orgId, orgId)))
      .then((rows) => rows[0] ?? null);
    if (!run) throw notFound("Run not found");
    if (run.agentId !== session.targetAgentId) {
      throw unprocessable("Feedback run must belong to the session target agent");
    }

    if (input.issueId) {
      const issue = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.orgId, orgId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
    }

    const [item] = await db
      .insert(runFeedbackItems)
      .values({
        orgId,
        sessionId,
        agentId: run.agentId,
        runId: input.runId,
        issueId: input.issueId ?? null,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId ?? null,
        eventId: input.eventId ?? null,
        eventSeq: input.eventSeq ?? null,
        logRef: input.logRef ?? null,
        logByteStart: input.logByteStart ?? null,
        logByteEnd: input.logByteEnd ?? null,
        transcriptEntryKey: input.transcriptEntryKey ?? null,
        selectedTextSnapshot: input.selectedTextSnapshot ?? null,
        contentHash: input.contentHash ?? hashText(`${input.sourceKind}:${input.selectedTextSnapshot ?? input.body}`),
        body: input.body,
        feedbackType: input.feedbackType ?? "behavior",
        severity: input.severity ?? "medium",
      })
      .returning();

    await db
      .update(runFeedbackSessions)
      .set({ updatedAt: new Date() })
      .where(eq(runFeedbackSessions.id, sessionId));

    return item!;
  }

  async function submitSession(
    orgId: string,
    sessionId: string,
    actor: LearningActor,
  ): Promise<SubmitRunFeedbackSessionResponse> {
    const session = await getSessionOrThrow(orgId, sessionId);
    if (session.status !== "draft") {
      const existingBatch = await db
        .select()
        .from(feedbackBatches)
        .where(and(eq(feedbackBatches.orgId, orgId), eq(feedbackBatches.sessionId, sessionId)))
        .then((rows) => rows[0] ?? null);
      if (!existingBatch) throw unprocessable("Feedback session is already submitted");
      const candidates = await db
        .select()
        .from(learningCandidates)
        .where(and(eq(learningCandidates.orgId, orgId), eq(learningCandidates.feedbackBatchId, existingBatch.id)))
        .orderBy(asc(learningCandidates.createdAt));
      return { batch: existingBatch as FeedbackBatch, candidates: candidates as LearningCandidate[] };
    }

    const items = await db
      .select()
      .from(runFeedbackItems)
      .where(and(eq(runFeedbackItems.orgId, orgId), eq(runFeedbackItems.sessionId, sessionId)))
      .orderBy(asc(runFeedbackItems.createdAt));
    if (items.length === 0) throw unprocessable("Add feedback before improving future runs");

    const [batch] = await db
      .insert(feedbackBatches)
      .values({
        orgId,
        sessionId,
        submittedByUserId: actor.actorType === "user" ? actor.actorId : null,
        submittedByAgentId: actor.actorType === "agent" ? actor.agentId : null,
        targetAgentId: session.targetAgentId,
        targetSkillId: session.targetSkillId,
        summary: buildBatchSummary(items),
        status: "reviewing",
      })
      .returning();

    const candidateRows = await db
      .insert(learningCandidates)
      .values(items.map((item) => {
        const draft = generateCandidateDraft(item);
        return {
          orgId,
          feedbackBatchId: batch!.id,
          targetAgentId: session.targetAgentId,
          targetSkillId: session.targetSkillId,
          title: draft.title,
          instruction: draft.instruction,
          appliesWhenJson: draft.appliesWhenJson,
          mustNot: draft.mustNot,
          targetSkillReason: draft.targetSkillReason,
          classification: draft.classification,
          confidence: draft.confidence,
          riskLevel: draft.riskLevel,
          validationChecksJson: draft.validationChecksJson,
          status: draft.classification === "one_off_correction" ? "one_off" : "pending",
        };
      }))
      .returning();

    await db
      .update(runFeedbackSessions)
      .set({ status: "submitted", updatedAt: new Date() })
      .where(eq(runFeedbackSessions.id, sessionId));

    return {
      batch: batch! as FeedbackBatch,
      candidates: candidateRows as LearningCandidate[],
    };
  }

  async function listRunFeedback(orgId: string, runId: string) {
    const run = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.orgId, orgId)))
      .then((rows) => rows[0] ?? null);
    if (!run) throw notFound("Run not found");

    const items = await db
      .select()
      .from(runFeedbackItems)
      .where(and(eq(runFeedbackItems.orgId, orgId), eq(runFeedbackItems.runId, runId)))
      .orderBy(desc(runFeedbackItems.createdAt));
    const sessionIds = Array.from(new Set(items.map((item) => item.sessionId)));
    const sessions = sessionIds.length === 0
      ? []
      : await db
        .select()
        .from(runFeedbackSessions)
        .where(and(eq(runFeedbackSessions.orgId, orgId), inArray(runFeedbackSessions.id, sessionIds)));
    const batches = sessionIds.length === 0
      ? []
      : await db
        .select()
        .from(feedbackBatches)
        .where(and(eq(feedbackBatches.orgId, orgId), inArray(feedbackBatches.sessionId, sessionIds)));

    return { items, sessions, batches };
  }

  async function getBatchReview(orgId: string, batchId: string): Promise<FeedbackBatchReview> {
    const batch = await getBatchOrThrow(orgId, batchId);
    const session = await getSessionOrThrow(orgId, batch.sessionId);
    const agent = await getAgentOrThrow(orgId, batch.targetAgentId);
    const targetSkill = batch.targetSkillId ? pickSkillPreview(await getSkillOrThrow(orgId, batch.targetSkillId)) : null;
    const [feedbackItemsForBatch, candidates, proposals, revisions] = await Promise.all([
      db
        .select()
        .from(runFeedbackItems)
        .where(and(eq(runFeedbackItems.orgId, orgId), eq(runFeedbackItems.sessionId, batch.sessionId)))
        .orderBy(asc(runFeedbackItems.createdAt)),
      db
        .select()
        .from(learningCandidates)
        .where(and(eq(learningCandidates.orgId, orgId), eq(learningCandidates.feedbackBatchId, batchId)))
        .orderBy(asc(learningCandidates.createdAt)),
      db
        .select()
        .from(skillUpdateProposals)
        .where(and(eq(skillUpdateProposals.orgId, orgId), eq(skillUpdateProposals.targetAgentId, batch.targetAgentId)))
        .orderBy(desc(skillUpdateProposals.createdAt))
        .limit(20),
      db
        .select()
        .from(organizationSkillRevisions)
        .where(and(eq(organizationSkillRevisions.orgId, orgId), eq(organizationSkillRevisions.createdFromFeedbackBatchId, batchId)))
        .orderBy(desc(organizationSkillRevisions.createdAt)),
    ]);
    const proposalIds = proposals.map((proposal) => proposal.id);
    const revisionIds = revisions.map((revision) => revision.id);
    const evidenceLinks = proposalIds.length === 0 && revisionIds.length === 0
      ? []
      : await db
        .select()
        .from(skillEvidenceLinks)
        .where(and(
          eq(skillEvidenceLinks.orgId, orgId),
          proposalIds.length > 0
            ? inArray(skillEvidenceLinks.skillUpdateProposalId, proposalIds)
            : inArray(skillEvidenceLinks.skillRevisionId, revisionIds),
        ))
        .orderBy(asc(skillEvidenceLinks.createdAt));

    return {
      batch: batch as FeedbackBatch,
      session: session as RunFeedbackSession,
      agent: {
        id: agent.id,
        name: agent.name,
        urlKey: agent.urlKey,
        title: agent.title,
        role: agent.role as FeedbackBatchReview["agent"]["role"],
        agentRuntimeType: agent.agentRuntimeType as FeedbackBatchReview["agent"]["agentRuntimeType"],
      },
      targetSkill,
      feedbackItems: feedbackItemsForBatch,
      candidates: candidates as LearningCandidate[],
      proposals: proposals as SkillUpdateProposal[],
      revisions,
      evidenceLinks,
    };
  }

  async function updateCandidate(orgId: string, candidateId: string, patch: UpdateLearningCandidateRequest) {
    const existing = await db
      .select()
      .from(learningCandidates)
      .where(and(eq(learningCandidates.id, candidateId), eq(learningCandidates.orgId, orgId)))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Learning candidate not found");
    if (existing.status === "applied") {
      throw unprocessable("Applied learnings are locked to their skill revision");
    }
    if (patch.targetSkillId) await getSkillOrThrow(orgId, patch.targetSkillId);

    const [updated] = await db
      .update(learningCandidates)
      .set(normalizeCandidatePatch(patch))
      .where(eq(learningCandidates.id, candidateId))
      .returning();
    return updated! as LearningCandidate;
  }

  async function setCandidateStatus(
    orgId: string,
    candidateId: string,
    status: "approved" | "rejected" | "one_off",
  ) {
    return updateCandidate(orgId, candidateId, { status });
  }

  async function getLatestRevision(skillId: string) {
    return db
      .select()
      .from(organizationSkillRevisions)
      .where(eq(organizationSkillRevisions.skillId, skillId))
      .orderBy(desc(organizationSkillRevisions.revision))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getNextRevisionNumber(skillId: string) {
    const row = await db
      .select({ value: sql<number>`coalesce(max(${organizationSkillRevisions.revision}), 0)::int` })
      .from(organizationSkillRevisions)
      .where(eq(organizationSkillRevisions.skillId, skillId))
      .then((rows) => rows[0] ?? null);
    return (row?.value ?? 0) + 1;
  }

  async function findOrCreateManagedSkill(orgId: string, agent: Awaited<ReturnType<typeof getAgentOrThrow>>) {
    const slug = managedLearningSkillSlug(agent);
    const existing = await db
      .select()
      .from(organizationSkillsTable)
      .where(and(eq(organizationSkillsTable.orgId, orgId), eq(organizationSkillsTable.slug, slug)))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    const created = await organizationSkills.createLocalSkill(orgId, {
      name: `Agent Learning - ${agent.name}`,
      slug,
      description: `Approved learnings from real run feedback for ${agent.name}.`,
      markdown: buildManagedSkillMarkdown(agent),
    });
    return getSkillOrThrow(orgId, created.id);
  }

  async function resolveApplySkill(
    orgId: string,
    agent: Awaited<ReturnType<typeof getAgentOrThrow>>,
    candidates: LearningCandidate[],
    batchTargetSkillId: string | null,
  ) {
    const targetSkillId = candidates.find((candidate) => candidate.targetSkillId)?.targetSkillId ?? batchTargetSkillId;
    if (targetSkillId) return getSkillOrThrow(orgId, targetSkillId);
    return findOrCreateManagedSkill(orgId, agent);
  }

  async function enableSkillForAgent(
    orgId: string,
    agent: Awaited<ReturnType<typeof getAgentOrThrow>>,
    skill: typeof organizationSkillsTable.$inferSelect,
  ) {
    const current = await organizationSkills.getEnabledSkillKeysForAgent(orgId, {
      id: agent.id,
      orgId: agent.orgId,
      agentRuntimeType: agent.agentRuntimeType,
      agentRuntimeConfig: agent.agentRuntimeConfig,
    });
    const selectionKey = `org:${skill.key}`;
    if (!current.includes(selectionKey)) {
      await organizationSkills.replaceEnabledSkillKeysForAgent(orgId, agent.id, [...current, selectionKey]);
    }
  }

  async function applyApproved(
    orgId: string,
    batchId: string,
    actor: LearningActor,
  ): Promise<ApplyApprovedLearningResponse> {
    const batch = await getBatchOrThrow(orgId, batchId);
    const agent = await getAgentOrThrow(orgId, batch.targetAgentId);
    const approved = await db
      .select()
      .from(learningCandidates)
      .where(and(
        eq(learningCandidates.orgId, orgId),
        eq(learningCandidates.feedbackBatchId, batchId),
        eq(learningCandidates.status, "approved"),
      ))
      .orderBy(asc(learningCandidates.createdAt));
    if (approved.length === 0) throw unprocessable("Approve at least one learning before applying");

    const skill = await resolveApplySkill(orgId, agent, approved as LearningCandidate[], batch.targetSkillId);
    const latestRevision = await getLatestRevision(skill.id);
    const baseMarkdown = skill.markdown;
    const learningPayloads: SkillLearning[] = approved.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      instruction: candidate.instruction,
      appliesWhenJson: parseObject(candidate.appliesWhenJson),
      mustNot: candidate.mustNot,
      validationChecksJson: readStringArray(candidate.validationChecksJson),
    }));
    const nextMarkdown = appendLearningsToSkillMarkdown({
      markdown: baseMarkdown,
      batchId,
      candidateLearnings: learningPayloads,
    });

    await organizationSkills.updateFile(orgId, skill.id, "SKILL.md", nextMarkdown);
    const refreshedSkill = await getSkillOrThrow(orgId, skill.id);
    const revisionNumber = await getNextRevisionNumber(skill.id);
    const proposalSummary = approved.length === 1
      ? approved[0]!.instruction
      : `${approved.length} approved learnings will be added to ${refreshedSkill.name}.`;
    const markdownDiff = learningPayloads
      .map((learning) => `+ ${learning.title}\n+ ${learning.instruction}`)
      .join("\n");

    const [proposal] = await db
      .insert(skillUpdateProposals)
      .values({
        orgId,
        targetSkillId: refreshedSkill.id,
        targetSkillKey: refreshedSkill.key,
        targetAgentId: agent.id,
        baseRevisionId: latestRevision?.id ?? null,
        baseContentHash: hashText(baseMarkdown),
        title: `Apply ${approved.length} learning${approved.length === 1 ? "" : "s"} to ${refreshedSkill.name}`,
        summary: proposalSummary,
        patchJson: safePatchJson(learningPayloads),
        markdownDiff,
        structuredSpecDiffJson: { activeLearnings: learningPayloads },
        rationale: `Approved from feedback batch ${batchId}.`,
        expectedBehavior: learningPayloads.map((learning) => learning.instruction).join("\n"),
        validationChecksJson: Array.from(new Set(learningPayloads.flatMap((learning) => learning.validationChecksJson))),
        riskLevel: approved.some((candidate) => candidate.riskLevel === "high")
          ? "high"
          : approved.some((candidate) => candidate.riskLevel === "medium")
            ? "medium"
            : "low",
        status: "applied",
        approvedByUserId: actor.actorType === "user" ? actor.actorId : null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        createdByAgentId: actor.actorType === "agent" ? actor.agentId : null,
        rollbackPlan: `Disable ${refreshedSkill.name} for ${agent.name} or revert to revision ${latestRevision?.revision ?? 0}.`,
      })
      .returning();

    const [revision] = await db
      .insert(organizationSkillRevisions)
      .values({
        orgId,
        skillId: refreshedSkill.id,
        revision: revisionNumber,
        markdown: nextMarkdown,
        structuredSpecJson: { activeLearnings: learningPayloads },
        contentHash: hashText(nextMarkdown),
        sourceProposalId: proposal!.id,
        createdFromFeedbackBatchId: batchId,
        status: "approved",
        approvedByUserId: actor.actorType === "user" ? actor.actorId : null,
        createdByAgentId: actor.actorType === "agent" ? actor.agentId : null,
      })
      .returning();

    const items = await db
      .select()
      .from(runFeedbackItems)
      .where(and(eq(runFeedbackItems.orgId, orgId), eq(runFeedbackItems.sessionId, batch.sessionId)))
      .orderBy(asc(runFeedbackItems.createdAt));
    if (items.length > 0) {
      await db.insert(skillEvidenceLinks).values(items.map((item) => ({
        orgId,
        skillUpdateProposalId: proposal!.id,
        skillRevisionId: revision!.id,
        feedbackItemId: item.id,
        runId: item.runId,
        issueId: item.issueId,
        eventId: item.eventId,
        eventSeq: item.eventSeq,
        evidenceSummary: compactText(item.body, 240),
      })));
    }

    await db
      .update(learningCandidates)
      .set({ status: "applied", targetSkillId: refreshedSkill.id, updatedAt: new Date() })
      .where(inArray(learningCandidates.id, approved.map((candidate) => candidate.id)));
    const [updatedBatch] = await db
      .update(feedbackBatches)
      .set({ status: "applied", targetSkillId: refreshedSkill.id, updatedAt: new Date() })
      .where(eq(feedbackBatches.id, batchId))
      .returning();

    await enableSkillForAgent(orgId, agent, refreshedSkill);

    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent_learning.skill_update_applied",
      entityType: "organization_skill",
      entityId: refreshedSkill.id,
      details: {
        targetAgentId: agent.id,
        feedbackBatchId: batchId,
        proposalId: proposal!.id,
        revisionId: revision!.id,
        revision: revision!.revision,
        learningCount: approved.length,
      },
    });

    return {
      batch: updatedBatch! as FeedbackBatch,
      appliedCandidates: approved.map((candidate) => ({
        ...candidate,
        status: "applied",
        targetSkillId: refreshedSkill.id,
      })) as LearningCandidate[],
      proposals: [proposal! as SkillUpdateProposal],
      revisions: [revision!],
      skill: pickSkillPreview(refreshedSkill),
    };
  }

  async function agentSummary(orgId: string, agentId: string): Promise<AgentLearningSummary> {
    const agent = await getAgentOrThrow(orgId, agentId);
    const managedSlug = managedLearningSkillSlug(agent);
    const managedSkill = await db
      .select()
      .from(organizationSkillsTable)
      .where(and(eq(organizationSkillsTable.orgId, orgId), eq(organizationSkillsTable.slug, managedSlug)))
      .then((rows) => rows[0] ?? null);

    const [appliedCandidates, suggestedUpdates, recentProposals, recentMisses] = await Promise.all([
      db
        .select()
        .from(learningCandidates)
        .where(and(
          eq(learningCandidates.orgId, orgId),
          eq(learningCandidates.targetAgentId, agentId),
          eq(learningCandidates.status, "applied"),
        ))
        .orderBy(desc(learningCandidates.updatedAt))
        .limit(20),
      db
        .select()
        .from(learningCandidates)
        .where(and(
          eq(learningCandidates.orgId, orgId),
          eq(learningCandidates.targetAgentId, agentId),
          eq(learningCandidates.status, "pending"),
        ))
        .orderBy(desc(learningCandidates.createdAt))
        .limit(10),
      db
        .select()
        .from(skillUpdateProposals)
        .where(and(
          eq(skillUpdateProposals.orgId, orgId),
          eq(skillUpdateProposals.targetAgentId, agentId),
          eq(skillUpdateProposals.status, "applied"),
        ))
        .orderBy(desc(skillUpdateProposals.updatedAt))
        .limit(10),
      db
        .select()
        .from(skillEvaluationReports)
        .where(and(eq(skillEvaluationReports.orgId, orgId), eq(skillEvaluationReports.agentId, agentId)))
        .orderBy(desc(skillEvaluationReports.createdAt))
        .limit(10),
    ]);

    const proposalIds = recentProposals.map((proposal) => proposal.id);
    const recentRevisions = proposalIds.length === 0
      ? []
      : await db
        .select()
        .from(organizationSkillRevisions)
        .where(and(eq(organizationSkillRevisions.orgId, orgId), inArray(organizationSkillRevisions.sourceProposalId, proposalIds)))
        .orderBy(desc(organizationSkillRevisions.createdAt))
        .limit(10);

    return {
      agentId,
      managedSkill: pickSkillPreview(managedSkill),
      activeLearnings: appliedCandidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        instruction: candidate.instruction,
        appliesWhenJson: parseObject(candidate.appliesWhenJson),
        mustNot: candidate.mustNot,
        revisionId: recentRevisions[0]?.id ?? null,
        revision: recentRevisions[0]?.revision ?? null,
        createdAt: candidate.updatedAt,
      })),
      suggestedUpdates: suggestedUpdates as LearningCandidate[],
      recentRevisions,
      recentMisses,
      stats: {
        activeLearningCount: appliedCandidates.length,
        suggestedCount: suggestedUpdates.length,
        recentRevisionCount: recentRevisions.length,
        recentMissCount: recentMisses.filter((report) => readStringArray(report.missedItemsJson).length > 0).length,
      },
    };
  }

  async function extractLoadedSkillsFromEvents(orgId: string, runId: string) {
    const events = await db
      .select({ payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents)
      .where(and(
        eq(heartbeatRunEvents.orgId, orgId),
        eq(heartbeatRunEvents.runId, runId),
        eq(heartbeatRunEvents.eventType, "adapter.invoke"),
      ))
      .orderBy(desc(heartbeatRunEvents.seq))
      .limit(1);
    const payload = parseObject(events[0]?.payload);
    const loadedSkills = Array.isArray(payload.loadedSkills) ? payload.loadedSkills : [];
    return loadedSkills.flatMap((entry) => {
      if (!isPlainRecord(entry)) return [];
      const key = readString(entry.key);
      if (!key) return [];
      return [{
        key,
        runtimeName: readString(entry.runtimeName),
        name: readString(entry.name),
      }];
    });
  }

  async function getRunLoadedSkills(orgId: string, runId: string): Promise<RunLoadedSkillsSummary> {
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.orgId, orgId)))
      .then((rows) => rows[0] ?? null);
    if (!run) throw notFound("Run not found");

    const [persistedLoaded, eventLoaded, evaluations] = await Promise.all([
      db
        .select()
        .from(runLoadedSkillRevisions)
        .where(and(eq(runLoadedSkillRevisions.orgId, orgId), eq(runLoadedSkillRevisions.runId, runId)))
        .orderBy(asc(runLoadedSkillRevisions.loadedAt)),
      extractLoadedSkillsFromEvents(orgId, runId),
      db
        .select()
        .from(skillEvaluationReports)
        .where(and(eq(skillEvaluationReports.orgId, orgId), eq(skillEvaluationReports.runId, runId)))
        .orderBy(desc(skillEvaluationReports.createdAt)),
    ]);

    const skillKeys = Array.from(new Set([
      ...persistedLoaded.map((entry) => entry.skillKey),
      ...eventLoaded.map((entry) => entry.key),
    ]));
    if (skillKeys.length === 0) {
      return { runId, loadedSkills: [], evaluations };
    }

    const orgSkillLookupKeys = Array.from(new Set(skillKeys.flatMap(runtimeSkillLookupKeys)));
    const orgSkillRows = orgSkillLookupKeys.length === 0
      ? []
      : await db
        .select()
        .from(organizationSkillsTable)
        .where(and(eq(organizationSkillsTable.orgId, orgId), inArray(organizationSkillsTable.key, orgSkillLookupKeys)));
    const orgSkillsByRuntimeKey = buildRuntimeSkillMap(orgSkillRows);
    const revisionRows = orgSkillRows.length === 0
      ? []
      : await db
        .select()
        .from(organizationSkillRevisions)
        .where(and(eq(organizationSkillRevisions.orgId, orgId), inArray(organizationSkillRevisions.skillId, orgSkillRows.map((skill) => skill.id))))
        .orderBy(desc(organizationSkillRevisions.revision));
    const latestRevisionBySkillId = new Map<string, typeof organizationSkillRevisions.$inferSelect>();
    const revisionById = new Map<string, typeof organizationSkillRevisions.$inferSelect>();
    for (const revision of revisionRows) {
      revisionById.set(revision.id, revision);
      if (!latestRevisionBySkillId.has(revision.skillId)) latestRevisionBySkillId.set(revision.skillId, revision);
    }
    const persistedByKey = new Map(persistedLoaded.map((entry) => [entry.skillKey, entry]));
    const eventByKey = new Map(eventLoaded.map((entry) => [entry.key, entry]));

    return {
      runId,
      loadedSkills: skillKeys.map((skillKey) => {
        const skill = orgSkillsByRuntimeKey.get(skillKey) ?? null;
        const persisted = persistedByKey.get(skillKey) ?? null;
        const latestRevision = skill ? latestRevisionBySkillId.get(skill.id) ?? null : null;
        const loadedRevision = persisted?.skillRevisionId
          ? revisionById.get(persisted.skillRevisionId) ?? latestRevision
          : latestRevision;
        const eventEntry = eventByKey.get(skillKey) ?? null;
        return {
          skillKey,
          skillName: skill?.name ?? eventEntry?.name ?? eventEntry?.runtimeName ?? null,
          skillRevisionId: persisted?.skillRevisionId ?? loadedRevision?.id ?? null,
          revision: loadedRevision?.revision ?? null,
          contentHash: persisted?.contentHash ?? loadedRevision?.contentHash ?? null,
          recentLearnings: loadedRevision
            ? parseLearningCandidatesFromStructuredSpec(loadedRevision.structuredSpecJson)
            : [],
        };
      }),
      evaluations,
    };
  }

  async function recordRunLoadedSkills(
    orgId: string,
    runId: string,
    agentId: string,
    entries: Array<{ key: string }>,
  ) {
    const skillKeys = Array.from(new Set(entries.map((entry) => entry.key).filter((key) => key.trim().length > 0)));
    await db
      .delete(runLoadedSkillRevisions)
      .where(and(eq(runLoadedSkillRevisions.orgId, orgId), eq(runLoadedSkillRevisions.runId, runId)));
    if (skillKeys.length === 0) return [];

    const orgSkillLookupKeys = Array.from(new Set(skillKeys.flatMap(runtimeSkillLookupKeys)));
    const orgSkillRows = orgSkillLookupKeys.length === 0
      ? []
      : await db
        .select()
        .from(organizationSkillsTable)
        .where(and(eq(organizationSkillsTable.orgId, orgId), inArray(organizationSkillsTable.key, orgSkillLookupKeys)));
    const orgSkillsByRuntimeKey = buildRuntimeSkillMap(orgSkillRows);
    const revisionRows = orgSkillRows.length === 0
      ? []
      : await db
        .select()
        .from(organizationSkillRevisions)
        .where(and(eq(organizationSkillRevisions.orgId, orgId), inArray(organizationSkillRevisions.skillId, orgSkillRows.map((skill) => skill.id))))
        .orderBy(desc(organizationSkillRevisions.revision));
    const latestRevisionBySkillId = new Map<string, typeof organizationSkillRevisions.$inferSelect>();
    for (const revision of revisionRows) {
      if (!latestRevisionBySkillId.has(revision.skillId)) latestRevisionBySkillId.set(revision.skillId, revision);
    }

    return db
      .insert(runLoadedSkillRevisions)
      .values(skillKeys.map((skillKey) => {
        const skill = orgSkillsByRuntimeKey.get(skillKey);
        const latestRevision = skill ? latestRevisionBySkillId.get(skill.id) ?? null : null;
        return {
          orgId,
          runId,
          agentId,
          skillKey,
          skillRevisionId: latestRevision?.id ?? null,
          contentHash: latestRevision?.contentHash ?? null,
        };
      }))
      .returning();
  }

  async function evaluateRunSkills(orgId: string, runId: string) {
    const summary = await getRunLoadedSkills(orgId, runId);
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run) throw notFound("Run not found");

    const searchable = [
      run.stdoutExcerpt,
      run.stderrExcerpt,
      JSON.stringify(run.resultJson ?? {}),
    ].filter((value): value is string => Boolean(value)).join("\n").toLowerCase();

    const reports = [];
    for (const skill of summary.loadedSkills) {
      const checks = skill.recentLearnings.map((learning) => learning.title);
      if (checks.length === 0) continue;
      const passed: string[] = [];
      const missed: string[] = [];
      for (const learning of skill.recentLearnings) {
        const text = `${learning.title} ${learning.instruction}`.toLowerCase();
        if (text.includes("agents.md")) {
          (searchable.includes("agents.md") ? passed : missed).push(learning.title);
        } else if (text.includes("closeout") || text.includes("done, blocked")) {
          (/(done|blocked|handoff|needs review)/i.test(searchable) ? passed : missed).push(learning.title);
        } else {
          missed.push(learning.title);
        }
      }
      const score = checks.length === 0 ? null : passed.length / checks.length;
      const [report] = await db
        .insert(skillEvaluationReports)
        .values({
          orgId,
          runId,
          agentId: run.agentId,
          skillRevisionId: skill.skillRevisionId,
          score,
          applicableChecksJson: checks,
          passedItemsJson: passed,
          missedItemsJson: missed,
          notes: "Deterministic MVP evaluation based on run excerpts and result metadata.",
        })
        .returning();
      reports.push(report!);
    }
    return reports;
  }

  return {
    createSession,
    addFeedbackItem,
    submitSession,
    listRunFeedback,
    getBatchReview,
    updateCandidate,
    setCandidateStatus,
    applyApproved,
    agentSummary,
    getRunLoadedSkills,
    recordRunLoadedSkills,
    evaluateRunSkills,
  };
}
