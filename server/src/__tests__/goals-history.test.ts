import {
  agents,
  applyPendingMigrations,
  approvals,
  assets,
  authUsers,
  createDb,
  createLocalPostgresInstance,
  ensurePostgresDatabase,
  goalActivities,
  goalChangeProposals,
  goalFeedbackEntries,
  goalResultProposals,
  goals,
  heartbeatRuns,
  issues,
  organizations,
  type LocalPostgresInstance,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { goalService } from "../services/goals.js";

const ORG_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "10000000-0000-4000-8000-000000000002";
const GOAL_ID = "10000000-0000-4000-8000-000000000003";
const AGENT_ID = "10000000-0000-4000-8000-000000000004";
const OTHER_AGENT_ID = "10000000-0000-4000-8000-00000000000a";
const FIRST_APPROVAL_ID = "10000000-0000-4000-8000-000000000005";
const SECOND_APPROVAL_ID = "10000000-0000-4000-8000-000000000006";
const LOCAL_ASSET_ID = "10000000-0000-4000-8000-000000000007";
const CROSS_ORG_ASSET_ID = "10000000-0000-4000-8000-000000000008";
const UNKNOWN_ASSET_ID = "10000000-0000-4000-8000-000000000009";
const USER_ID = "goal-history-user";

const TIE_TIME = new Date("2026-08-07T12:00:00.000Z");
const OLDER_TIME = new Date("2026-08-07T11:00:00.000Z");

const HISTORY_IDS = {
  activityFirst: "20000000-0000-4000-8000-000000000001",
  activitySecond: "20000000-0000-4000-8000-000000000002",
  activityOlder: "20000000-0000-4000-8000-000000000003",
  feedbackTie: "30000000-0000-4000-8000-000000000001",
  feedbackOlder: "30000000-0000-4000-8000-000000000002",
  changeTie: "40000000-0000-4000-8000-000000000001",
  changeOlder: "40000000-0000-4000-8000-000000000002",
  resultTie: "50000000-0000-4000-8000-000000000001",
  resultOlder: "50000000-0000-4000-8000-000000000002",
} as const;

const TIMELINE_IDS = {
  queuedRun: "60000000-0000-4000-8000-000000000001",
  completedRun: "60000000-0000-4000-8000-000000000002",
  linkedIssue: "70000000-0000-4000-8000-000000000001",
  linkedIssueRun: "60000000-0000-4000-8000-000000000003",
  crossOrgRun: "60000000-0000-4000-8000-000000000004",
} as const;

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-goals-history-"));
  const port = await getAvailablePort();
  const { instance } = await createLocalPostgresInstance({
    databaseDir: dataDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();
  const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

async function seedHistory(db: ReturnType<typeof createDb>) {
  await db.insert(organizations).values([
    {
      id: ORG_ID,
      name: "Goal history organization",
      urlKey: deriveOrganizationUrlKey("Goal history organization"),
      issuePrefix: "GHIST",
      requireBoardApprovalForNewAgents: false,
    },
    {
      id: OTHER_ORG_ID,
      name: "Other history organization",
      urlKey: deriveOrganizationUrlKey("Other history organization"),
      issuePrefix: "OHIST",
      requireBoardApprovalForNewAgents: false,
    },
  ]);
  await db.insert(agents).values([
    {
      id: AGENT_ID,
      orgId: ORG_ID,
      name: "History agent",
      role: "engineer",
      status: "idle",
      capabilities: "Produces inspectable Goal history evidence.",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
    {
      id: OTHER_AGENT_ID,
      orgId: OTHER_ORG_ID,
      name: "Other organization agent",
      role: "engineer",
      status: "idle",
      capabilities: "Produces other organization evidence.",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
  ]);
  await db.insert(authUsers).values({
    id: USER_ID,
    name: "History user",
    email: "history@example.test",
    createdAt: OLDER_TIME,
    updatedAt: OLDER_TIME,
  });
  await db.insert(goals).values({
    id: GOAL_ID,
    orgId: ORG_ID,
    title: "Keep Goal history complete and private",
    outcomeStatement: "Goal history is complete, stable, and organization-scoped",
    lifecycle: "active",
    ownerAgentId: AGENT_ID,
  });
  await db.insert(issues).values({
    id: TIMELINE_IDS.linkedIssue,
    orgId: ORG_ID,
    goalId: GOAL_ID,
    title: "Issue linked to the Goal",
    status: "in_progress",
    priority: "medium",
  });
  await db.insert(approvals).values([
    {
      id: FIRST_APPROVAL_ID,
      orgId: ORG_ID,
      type: "goal_change",
      requestedByAgentId: AGENT_ID,
      status: "pending",
      payload: {},
    },
    {
      id: SECOND_APPROVAL_ID,
      orgId: ORG_ID,
      type: "goal_change",
      requestedByAgentId: AGENT_ID,
      status: "approved",
      payload: {},
    },
  ]);
  await db.insert(assets).values([
    {
      id: LOCAL_ASSET_ID,
      orgId: ORG_ID,
      provider: "local_disk",
      objectKey: "goal-history/local.txt",
      contentType: "text/plain",
      byteSize: 12,
      sha256: "local-history-sha",
      originalFilename: "local.txt",
    },
    {
      id: CROSS_ORG_ASSET_ID,
      orgId: OTHER_ORG_ID,
      provider: "local_disk",
      objectKey: "goal-history/cross-org.txt",
      contentType: "text/plain",
      byteSize: 16,
      sha256: "cross-org-history-sha",
      originalFilename: "cross-org.txt",
    },
  ]);

  await db.insert(goalActivities).values([
    {
      id: HISTORY_IDS.activityFirst,
      orgId: ORG_ID,
      goalId: GOAL_ID,
      contractRevision: 1,
      submittedByAgentId: AGENT_ID,
      agentOwnerRefAtTime: AGENT_ID,
      activityKind: "progress",
      summary: "Agent activity at the tied timestamp",
      evidenceRefs: ["artifact://activity-tie"],
      runRef: TIMELINE_IDS.completedRun,
      idempotencyKey: "history-activity-tie-first",
      occurredAt: TIE_TIME,
    },
    {
      id: HISTORY_IDS.activitySecond,
      orgId: ORG_ID,
      goalId: GOAL_ID,
      contractRevision: 1,
      submittedByAgentId: null,
      agentOwnerRefAtTime: AGENT_ID,
      activityKind: "checkpoint",
      summary: "System activity at the tied timestamp",
      evidenceRefs: [],
      idempotencyKey: "history-activity-tie-second",
      occurredAt: TIE_TIME,
    },
    {
      id: HISTORY_IDS.activityOlder,
      orgId: ORG_ID,
      goalId: GOAL_ID,
      contractRevision: 1,
      submittedByAgentId: AGENT_ID,
      agentOwnerRefAtTime: AGENT_ID,
      activityKind: "evidence",
      summary: "Older activity",
      evidenceRefs: ["artifact://activity-older"],
      idempotencyKey: "history-activity-older",
      occurredAt: OLDER_TIME,
    },
  ]);
  await db.insert(goalFeedbackEntries).values([
    {
      id: HISTORY_IDS.feedbackTie,
      orgId: ORG_ID,
      goalId: GOAL_ID,
      actorType: "user",
      actorId: USER_ID,
      body: "Feedback at the tied timestamp",
      attachments: [],
      contentHash: "feedback-tie-hash",
      feedbackKind: "ordinary",
      idempotencyKey: "history-feedback-tie",
      createdAt: TIE_TIME,
      updatedAt: TIE_TIME,
    },
    {
      id: HISTORY_IDS.feedbackOlder,
      orgId: ORG_ID,
      goalId: GOAL_ID,
      actorType: "user",
      actorId: USER_ID,
      body: "Older feedback with scoped attachments",
      attachments: [
        { name: "local.txt", uri: `asset://${LOCAL_ASSET_ID}`, mimeType: "text/plain", size: 12 },
        { name: "cross-org.txt", uri: `asset://${CROSS_ORG_ASSET_ID}`, mimeType: "text/plain", size: 16 },
        { name: "unknown.txt", uri: `asset://${UNKNOWN_ASSET_ID}`, mimeType: "text/plain", size: 14 },
      ],
      contentHash: "feedback-older-hash",
      feedbackKind: "consequential",
      idempotencyKey: "history-feedback-older",
      createdAt: OLDER_TIME,
      updatedAt: OLDER_TIME,
    },
  ]);

  const beforeContract = {
    contractRevision: 1,
    outcomeStatement: "Goal history is complete, stable, and organization-scoped",
    objectiveMode: "target" as const,
    criteria: [],
    autonomyEnvelope: {},
    humanAuthorities: {},
    evaluationPolicy: {},
    actionDeadline: null,
    evaluationDeadline: null,
  };
  await db.insert(goalChangeProposals).values([
    {
      id: HISTORY_IDS.changeTie,
      orgId: ORG_ID,
      goalId: GOAL_ID,
      expectedContractRevision: 1,
      beforeContract,
      afterContract: { outcomeStatement: "Tied change proposal" },
      rationale: "Change proposal at the tied timestamp",
      evidenceRefs: ["artifact://change-tie"],
      approvalId: FIRST_APPROVAL_ID,
      status: "pending",
      idempotencyKey: "history-change-tie",
      proposedByAgentId: AGENT_ID,
      createdAt: TIE_TIME,
      updatedAt: TIE_TIME,
    },
    {
      id: HISTORY_IDS.changeOlder,
      orgId: ORG_ID,
      goalId: GOAL_ID,
      expectedContractRevision: 1,
      beforeContract,
      afterContract: { outcomeStatement: "Older change proposal" },
      rationale: "Older change proposal",
      evidenceRefs: ["artifact://change-older"],
      approvalId: SECOND_APPROVAL_ID,
      status: "approved",
      idempotencyKey: "history-change-older",
      proposedByAgentId: AGENT_ID,
      createdAt: OLDER_TIME,
      updatedAt: OLDER_TIME,
    },
  ]);

  const resultCandidate = {
    evidenceRefs: ["artifact://result"],
    criteria: [],
    resultPayload: {},
  };
  const resultPreflight = {
    mode: "target" as const,
    outcome: "achieved",
    criteria: [],
    evidenceRefs: ["artifact://result"],
    decision: null,
    evaluatedAt: TIE_TIME.toISOString(),
  };
  await db.insert(goalResultProposals).values([
    {
      id: HISTORY_IDS.resultTie,
      orgId: ORG_ID,
      goalId: GOAL_ID,
      contractRevision: 1,
      candidate: resultCandidate,
      candidateHash: "result-tie-hash",
      preflight: resultPreflight,
      riskSummary: "Tied result proposal risk",
      status: "accepted",
      idempotencyKey: "history-result-tie",
      proposedByAgentId: AGENT_ID,
      createdAt: TIE_TIME,
      updatedAt: TIE_TIME,
    },
    {
      id: HISTORY_IDS.resultOlder,
      orgId: ORG_ID,
      goalId: GOAL_ID,
      contractRevision: 1,
      candidate: resultCandidate,
      candidateHash: "result-older-hash",
      preflight: { ...resultPreflight, evaluatedAt: OLDER_TIME.toISOString() },
      riskSummary: "Older result proposal risk",
      status: "rejected",
      idempotencyKey: "history-result-older",
      proposedByAgentId: AGENT_ID,
      createdAt: OLDER_TIME,
      updatedAt: OLDER_TIME,
    },
  ]);
  await db.insert(heartbeatRuns).values([
    {
      id: TIMELINE_IDS.queuedRun,
      orgId: ORG_ID,
      agentId: AGENT_ID,
      goalId: GOAL_ID,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { goalId: GOAL_ID },
      createdAt: new Date("2026-08-07T13:00:00.000Z"),
      updatedAt: new Date("2026-08-07T13:00:00.000Z"),
    },
    {
      id: TIMELINE_IDS.completedRun,
      orgId: ORG_ID,
      agentId: AGENT_ID,
      goalId: GOAL_ID,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: { goalId: GOAL_ID, issueId: TIMELINE_IDS.linkedIssue },
      createdAt: new Date("2026-08-07T12:30:00.000Z"),
      updatedAt: new Date("2026-08-07T12:30:00.000Z"),
    },
    {
      id: TIMELINE_IDS.linkedIssueRun,
      orgId: ORG_ID,
      agentId: AGENT_ID,
      goalId: null,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: { issueId: TIMELINE_IDS.linkedIssue },
      createdAt: new Date("2026-08-07T13:30:00.000Z"),
      updatedAt: new Date("2026-08-07T13:30:00.000Z"),
    },
    {
      id: TIMELINE_IDS.crossOrgRun,
      orgId: OTHER_ORG_ID,
      agentId: OTHER_AGENT_ID,
      goalId: GOAL_ID,
      invocationSource: "on_demand",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { goalId: GOAL_ID },
      createdAt: new Date("2026-08-07T14:00:00.000Z"),
      updatedAt: new Date("2026-08-07T14:00:00.000Z"),
    },
  ]);
}

describe("Goal history service", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: LocalPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
    await seedHistory(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects malformed cursors as a bad request", async () => {
    const service = goalService(db);
    const invalidPayload = Buffer.from(JSON.stringify({
      version: 1,
      createdAt: TIE_TIME.toISOString(),
      kind: "unknown",
      id: HISTORY_IDS.activityFirst,
    })).toString("base64url");

    await expect(service.history(GOAL_ID, { cursor: "not-a-cursor" })).rejects.toMatchObject({
      status: 400,
      message: "Invalid Goal history cursor",
    });
    await expect(service.history(GOAL_ID, { cursor: invalidPayload })).rejects.toMatchObject({
      status: 400,
      message: "Invalid Goal history cursor",
    });
  });

  it("paginates every history kind without gaps or duplicates and keeps tied rows stable", async () => {
    const service = goalService(db);
    const pages = [];
    let cursor: string | null = null;

    do {
      const page = await service.history(GOAL_ID, { cursor, limit: 2 });
      pages.push(page);
      cursor = page.nextCursor;
      if (pages.length > 10) throw new Error("Goal history cursor did not terminate");
    } while (cursor);

    const items = pages.flatMap((page) => page.items);
    const identities = items.map((item) => `${item.kind}:${item.id}`);
    expect(identities).toEqual([
      `activity:${HISTORY_IDS.activityFirst}`,
      `activity:${HISTORY_IDS.activitySecond}`,
      `change_proposal:${HISTORY_IDS.changeTie}`,
      `feedback:${HISTORY_IDS.feedbackTie}`,
      `result_proposal:${HISTORY_IDS.resultTie}`,
      `activity:${HISTORY_IDS.activityOlder}`,
      `change_proposal:${HISTORY_IDS.changeOlder}`,
      `feedback:${HISTORY_IDS.feedbackOlder}`,
      `result_proposal:${HISTORY_IDS.resultOlder}`,
    ]);
    expect(new Set(identities).size).toBe(identities.length);
    expect(pages).toHaveLength(5);
    expect(pages.at(-1)?.nextCursor).toBeNull();

    expect(items.find((item) => item.id === HISTORY_IDS.activityFirst)).toMatchObject({
      actorType: "agent",
      actorId: AGENT_ID,
      actorName: "History agent",
    });
    expect(items.find((item) => item.id === HISTORY_IDS.activitySecond)).toMatchObject({
      actorType: "system",
      actorId: null,
      actorName: "System",
    });
    expect(items.find((item) => item.id === HISTORY_IDS.feedbackTie)).toMatchObject({
      actorType: "user",
      actorId: USER_ID,
      actorName: "History user",
    });
    expect(items.find((item) => item.id === HISTORY_IDS.changeTie)).toMatchObject({
      actorType: "agent",
      actorId: AGENT_ID,
      actorName: "History agent",
    });
    expect(items.find((item) => item.id === HISTORY_IDS.resultTie)).toMatchObject({
      actorType: "agent",
      actorId: AGENT_ID,
      actorName: "History agent",
    });
  });

  it("uses plain-language closeout summaries for every terminal Goal outcome", async () => {
    const service = goalService(db);
    const terminalCases = [
      {
        outcome: "achieved",
        objectiveMode: "target",
        evaluator: "artifact",
        criterionStatus: "met",
        resultValue: null,
        decision: null,
        expectedSummary: "Goal achieved",
      },
      {
        outcome: "not_achieved",
        objectiveMode: "target",
        evaluator: "artifact",
        criterionStatus: "unmet",
        resultValue: null,
        decision: null,
        expectedSummary: "Goal not achieved",
      },
      {
        outcome: "completed_with_result",
        objectiveMode: "maximize",
        evaluator: "metric",
        criterionStatus: "met",
        resultValue: 42,
        decision: null,
        expectedSummary: "Goal completed with a measured result",
      },
      {
        outcome: "maintained",
        objectiveMode: "maintain",
        evaluator: "policy",
        criterionStatus: "met",
        resultValue: null,
        decision: null,
        expectedSummary: "Goal maintained",
      },
      {
        outcome: "breached",
        objectiveMode: "maintain",
        evaluator: "policy",
        criterionStatus: "breached",
        resultValue: null,
        decision: null,
        expectedSummary: "Goal condition breached",
      },
      {
        outcome: "decided",
        objectiveMode: "decide",
        evaluator: "human",
        criterionStatus: "met",
        resultValue: null,
        decision: "Proceed with the verified option.",
        expectedSummary: "Goal completed with a decision",
      },
    ] as const;

    for (const terminalCase of terminalCases) {
      const draft = await service.create(ORG_ID, {
        title: `Close Goal with a user-readable result: ${terminalCase.expectedSummary}`,
        ownerAgentId: AGENT_ID,
      });
      const active = await service.activate(draft.id, {
        confirmed: true,
        ownerAgentId: AGENT_ID,
        outcomeStatement: `Record a user-readable closeout: ${terminalCase.expectedSummary}`,
        objectiveMode: terminalCase.objectiveMode,
        criteria: [{
          id: "terminal-outcome",
          label: "Terminal outcome is supported",
          evaluator: terminalCase.evaluator,
        }],
        autonomyEnvelope: {},
        humanAuthorities: {},
        evaluationPolicy: {},
        initialPlan: { summary: "Produce terminal evidence" },
        initialContinuation: { kind: "verification", summary: "Verify the terminal outcome" },
      }, AGENT_ID);
      const proposal = await service.createResultProposal(active.id, {
        evidenceRefs: ["artifact://goal-history/terminal-proof"],
        criteria: [{ id: "terminal-outcome", status: terminalCase.criterionStatus }],
        ...(terminalCase.resultValue === null ? {} : { resultValue: terminalCase.resultValue }),
        ...(terminalCase.decision === null ? {} : { decision: terminalCase.decision }),
        resultPayload: {},
        contractRevision: active.contractRevision,
        riskSummary: "Closeout risk was reviewed.",
        idempotencyKey: `goal-history-proposal-${terminalCase.outcome}`,
      }, AGENT_ID);
      expect(proposal.preflight.outcome).toBe(terminalCase.outcome);

      await service.acceptResultProposal(proposal.id, {
        idempotencyKey: `goal-history-accept-${terminalCase.outcome}`,
      }, USER_ID);

      const page = await service.history(active.id, { limit: 100 });
      const closeout = page.items.find((item) =>
        item.kind === "activity" && item.summary === terminalCase.expectedSummary
      );
      expect(closeout).toMatchObject({
        summary: terminalCase.expectedSummary,
        evidence: [{ label: "Supporting work 1", href: null, external: false }],
      });
      expect(closeout?.summary).not.toContain("evaluated as");
      expect(closeout?.summary).not.toContain(terminalCase.evaluator);
      expect(closeout?.summary).not.toContain("_");
      expect(JSON.stringify(page.items)).not.toContain(`Goal evaluated as ${terminalCase.outcome}`);
    }
  }, 30_000);

  it("projects legacy closeout enum summaries into public language", async () => {
    const legacyActivityId = randomUUID();
    await db.insert(goalActivities).values({
      id: legacyActivityId,
      orgId: ORG_ID,
      goalId: GOAL_ID,
      contractRevision: 1,
      submittedByAgentId: AGENT_ID,
      agentOwnerRefAtTime: AGENT_ID,
      activityKind: "closeout",
      summary: "Goal evaluated as completed_with_result",
      evidenceRefs: ["artifact://goal-history/legacy-closeout"],
      idempotencyKey: "legacy-closeout-summary",
    });

    const page = await goalService(db).history(GOAL_ID, { limit: 100 });
    expect(page.items.find((item) => item.id === legacyActivityId)).toMatchObject({
      summary: "Goal completed with a measured result",
    });
    expect(JSON.stringify(page.items)).not.toContain("completed_with_result");
    expect(JSON.stringify(page.items)).not.toContain("Goal evaluated as");
  });

  it("only exposes content paths for assets in the Goal organization", async () => {
    const page = await goalService(db).history(GOAL_ID, { limit: 100 });
    const feedback = page.items.find((item) => item.id === HISTORY_IDS.feedbackOlder);

    expect(feedback?.attachments).toEqual([
      {
        name: "local.txt",
        mimeType: "text/plain",
        size: 12,
        contentPath: `/api/assets/${LOCAL_ASSET_ID}/content`,
      },
      {
        name: "cross-org.txt",
        mimeType: "text/plain",
        size: 16,
        contentPath: null,
      },
      {
        name: "unknown.txt",
        mimeType: "text/plain",
        size: 14,
        contentPath: null,
      },
    ]);
    const serializedFeedback = JSON.stringify(feedback);
    expect(serializedFeedback).not.toContain(`asset://${CROSS_ORG_ASSET_ID}`);
    expect(serializedFeedback).not.toContain(`asset://${UNKNOWN_ASSET_ID}`);
    expect(serializedFeedback).not.toContain('"uri"');
  });

  it("mixes explicitly bound Agent Runs without inferring ownership from linked Issues", async () => {
    const page = await goalService(db).timeline(GOAL_ID, { limit: 100 });
    const runItems = page.items.filter((item) => item.source === "agent-run");
    expect(runItems.map((item) => item.item.id)).toEqual([
      TIMELINE_IDS.queuedRun,
      TIMELINE_IDS.completedRun,
    ]);
    expect(runItems.every((item) => item.item.goalId === GOAL_ID)).toBe(true);
    expect(page.hasLiveRuns).toBe(true);

    const activity = page.items.find((item) => item.source === "goal-history" && item.item.id === HISTORY_IDS.activityFirst);
    expect(activity?.source === "goal-history" ? activity.item.runId : null).toBe(TIMELINE_IDS.completedRun);
    expect(JSON.stringify(page.items)).not.toContain(TIMELINE_IDS.linkedIssueRun);
    expect(JSON.stringify(page.items)).not.toContain(TIMELINE_IDS.crossOrgRun);
  });
});
