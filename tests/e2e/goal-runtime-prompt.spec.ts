import { expect, test, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { and, eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  agentWakeupRequests,
  createDb,
  goals,
  heartbeatRunEvents,
  heartbeatRuns,
} from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

type Organization = { id: string };
type Agent = { id: string };
type Goal = { id: string; lifecycle: string };
type StartPreview = {
  valid: boolean;
  packetHash: string;
  packet: {
    ownerAgentId: string;
    activation: {
      initialPlan: { summary: string };
      criteria: Array<{ id: string }>;
    };
  };
};

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function createOrganization(request: APIRequestContext) {
  const response = await request.post("/api/orgs", {
    data: { name: `Goal-runtime-prompt-${Date.now()}` },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Organization>;
}

async function createAgent(request: APIRequestContext, orgId: string) {
  const response = await request.post(`/api/orgs/${orgId}/agents`, {
    data: {
      name: "Goal prompt owner",
      role: "engineer",
      capabilities: "Plan bounded work, execute it, recover, and collect verifiable evidence.",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.4" },
    },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Agent>;
}

async function createAgentKey(request: APIRequestContext, agentId: string) {
  const response = await request.post(`/api/agents/${agentId}/keys`, {
    data: { name: "goal-runtime-prompt-e2e" },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ token: string }>;
}

async function waitForWakeRun(
  goalId: string,
  reason: "goal_started" | "goal_feedback" | "goal_change_decided",
  idempotencyKey: string,
) {
  let runId: string | null = null;
  await expect.poll(async () => {
    const wakeup = await e2eDb.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.reason, reason),
      eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
    )).then((rows) => rows.find((row) => {
      const payload = row.payload as Record<string, unknown> | null;
      return payload?.goalId === goalId;
    }) ?? null);
    runId = wakeup?.runId ?? null;
    return runId;
  }, { timeout: 45_000 }).not.toBeNull();
  return runId!;
}

async function waitForAdapterPrompt(runId: string) {
  let prompt: string | null = null;
  await expect.poll(async () => {
    const event = await e2eDb.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, runId),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    )).then((rows) => rows[0] ?? null);
    const payload = event?.payload as Record<string, unknown> | null;
    prompt = typeof payload?.prompt === "string" ? payload.prompt : null;
    return prompt?.length ?? 0;
  }, { timeout: 45_000 }).toBeGreaterThan(0);
  return prompt!;
}

async function waitForRunTerminal(runId: string) {
  await expect.poll(async () => {
    const run = await e2eDb.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    return run?.status ?? null;
  }, { timeout: 45_000 }).toBe("succeeded");
}

test("assembles the complete Goal advancement protocol for every production wake", async ({ request }) => {
  test.setTimeout(180_000);
  const settingsResponse = await request.patch("/api/instance/settings/general", {
    data: { experimentalGoalsEnabled: true },
  });
  expect(settingsResponse.ok()).toBe(true);

  const organization = await createOrganization(request);
  const owner = await createAgent(request, organization.id);
  const ownerKey = await createAgentKey(request, owner.id);
  const agentHeaders = { Authorization: `Bearer ${ownerKey.token}` };

  const previewResponse = await request.post(`/api/orgs/${organization.id}/goals/start-preview`, {
    data: {
      title: "Publish a verified Goal runtime candidate",
      context: "The candidate must preserve its Plan across feedback and governed changes.",
      ownerAgentId: owner.id,
      targetTime: "2026-08-20T10:00:00.000Z",
    },
  });
  expect(previewResponse.ok()).toBe(true);
  const preview = await previewResponse.json() as StartPreview;
  expect(preview.valid).toBe(true);

  const startResponse = await request.post(`/api/orgs/${organization.id}/goals/start`, {
    data: {
      requestKey: randomUUID(),
      packetHash: preview.packetHash,
      packet: preview.packet,
    },
  });
  expect(startResponse.status()).toBe(201);
  const goal = await startResponse.json() as Goal;

  const startWakeup = await e2eDb.select().from(agentWakeupRequests).where(
    eq(agentWakeupRequests.reason, "goal_started"),
  ).then((rows) => rows.find((row) => {
    const payload = row.payload as Record<string, unknown> | null;
    return payload?.goalId === goal.id;
  }) ?? null);
  expect(startWakeup?.idempotencyKey).toBeTruthy();
  const startRunId = await waitForWakeRun(goal.id, "goal_started", startWakeup!.idempotencyKey!);
  const startPrompt = await waitForAdapterPrompt(startRunId);
  expect(startPrompt).toContain("## Wake Entry - Goal Started");
  expect(startPrompt).toContain(preview.packet.activation.initialPlan.summary);
  expect(startPrompt).toContain("Validate and use the persisted initial Plan before replacing it.");
  expect(startPrompt).toContain("Do not mark or claim the Goal blocked the first time a blocker appears.");
  expect(startPrompt).toContain("persists for three consecutive Goal turns, first perform a Replan audit");
  expect(startPrompt).toContain("Stop execution while a Result Proposal is ready for human Acceptance.");
  expect(startPrompt).toContain("A human must accept every terminal Goal result.");

  const contextResponse = await request.get(`/api/goals/${goal.id}/agent-context`, {
    headers: agentHeaders,
  });
  expect(contextResponse.ok()).toBe(true);
  expect(await contextResponse.json()).toMatchObject({
    plan: { revision: 1, summary: preview.packet.activation.initialPlan.summary },
  });
  await waitForRunTerminal(startRunId);

  const feedbackResponse = await request.post(`/api/goals/${goal.id}/feedback`, {
    data: {
      body: "Keep the accepted outcome, but test a materially different recovery path.",
      attachments: [],
      feedbackKind: "ordinary",
      idempotencyKey: randomUUID(),
    },
  });
  expect(feedbackResponse.status()).toBe(201);
  const feedback = await feedbackResponse.json() as { id: string };
  const feedbackRunId = await waitForWakeRun(
    goal.id,
    "goal_feedback",
    `goal-feedback:${feedback.id}`,
  );
  const feedbackPrompt = await waitForAdapterPrompt(feedbackRunId);
  expect(feedbackPrompt).toContain("## Wake Entry - Goal Feedback");
  expect(feedbackPrompt).toContain("Keep the accepted outcome, but test a materially different recovery path.");
  expect(feedbackPrompt).toContain(preview.packet.activation.initialPlan.summary);
  expect(feedbackPrompt).toContain("new fact or Evidence -> observe and checkpoint");
  expect(feedbackPrompt).toContain("label the proposed strategy as Run-local and unpersisted");
  expect(feedbackPrompt).toContain("do not imply that Rudder will resume it automatically");
  await waitForRunTerminal(feedbackRunId);

  const goalRow = await e2eDb.select({ contractRevision: goals.contractRevision }).from(goals)
    .where(eq(goals.id, goal.id))
    .then((rows) => rows[0]!);
  const changeResponse = await request.post(`/api/goals/${goal.id}/change-proposals`, {
    headers: agentHeaders,
    data: {
      expectedContractRevision: goalRow.contractRevision,
      afterContract: {
        outcomeStatement: "Publish a verified Goal runtime candidate with recovery evidence",
      },
      rationale: "The accepted result should include recovery evidence.",
      evidenceRefs: ["artifact://goal-runtime/recovery"],
      idempotencyKey: randomUUID(),
    },
  });
  expect(changeResponse.status()).toBe(201);
  const change = await changeResponse.json() as { id: string };
  const decisionResponse = await request.post(`/api/goal-change-proposals/${change.id}/decide`, {
    data: { decision: "approve", note: "Apply the scoped recovery requirement." },
  });
  expect(decisionResponse.ok()).toBe(true);

  const decisionRunId = await waitForWakeRun(
    goal.id,
    "goal_change_decided",
    `goal-change-decision:${change.id}:approve`,
  );
  const decisionPrompt = await waitForAdapterPrompt(decisionRunId);
  expect(decisionPrompt).toContain("## Wake Entry - Goal Change Decision");
  expect(decisionPrompt).toContain("**Decision:** approve");
  expect(decisionPrompt).toContain("**Decision status:** applied");
  expect(decisionPrompt).toContain("Apply the scoped recovery requirement.");
  expect(decisionPrompt).toContain(preview.packet.activation.initialPlan.summary);
  expect(decisionPrompt).toContain("invalidate Plan assumptions tied to the prior revision");
  await waitForRunTerminal(decisionRunId);

  const changedGoalRow = await e2eDb.select({ contractRevision: goals.contractRevision }).from(goals)
    .where(eq(goals.id, goal.id))
    .then((rows) => rows[0]!);
  const resultResponse = await request.post(`/api/goals/${goal.id}/result-proposals`, {
    headers: {
      ...agentHeaders,
      "x-rudder-run-id": decisionRunId,
    },
    data: {
      contractRevision: changedGoalRow.contractRevision,
      criteria: [{ id: preview.packet.activation.criteria[0]!.id, status: "met" }],
      evidenceRefs: ["artifact://goal-runtime/verified-result"],
      resultPayload: {},
      riskSummary: "No unresolved acceptance risk.",
      idempotencyKey: randomUUID(),
    },
  });
  expect(resultResponse.status()).toBe(201);
  const result = await resultResponse.json() as { id: string; status: string };
  expect(result.status).toBe("ready");
  expect((await request.get(`/api/goals/${goal.id}`).then((response) => response.json()) as Goal).lifecycle)
    .toBe("active");

  const acceptResponse = await request.post(`/api/goal-result-proposals/${result.id}/accept`, {
    data: { idempotencyKey: randomUUID() },
  });
  expect(acceptResponse.ok()).toBe(true);
  expect((await acceptResponse.json() as Goal).lifecycle).toBe("closed");
});
