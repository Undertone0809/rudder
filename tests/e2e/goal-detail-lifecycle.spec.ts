import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  agentWakeupRequests,
  approvals,
  createDb,
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
} from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";
import { restartE2eServer, stopRestartedE2eServer } from "./support/restart-e2e-server";

const e2eDb = createDb(E2E_DATABASE_URL);

type Organization = {
  id: string;
  urlKey: string;
};

type Agent = {
  id: string;
  name: string;
};

type AgentOptions = {
  role?: string;
  title?: string | null;
  capabilities?: string | null;
};

type Goal = {
  id: string;
  orgId: string;
  title: string;
  lifecycle: string;
  status: string;
  contractRevision: number;
  ownerAgentId: string | null;
  focus: boolean;
  evaluationResult: { outcome?: string } | null;
};

type StartPreview = {
  valid: boolean;
  packetHash: string | null;
  packet: {
    version: 1;
    activation: {
      objectiveMode: "target" | "maximize" | "maintain" | "decide";
      criteria: Array<{ id: string; label: string; evaluator: string }>;
    };
  } | null;
  review: {
    outcome: string;
    success: string;
    boundary: string;
    firstAction: string;
  } | null;
  alignmentQuestion: string | null;
};

type Workspace = {
  goal: Goal;
  facet: string;
  currentProgress: {
    summary: string;
    sourceActivityId: string | null;
    evidenceRefs: string[];
  };
  attention: { kind: string; reason: string; sourceId: string | null } | null;
  timeline: Array<{ id: string; kind: string; summary: string }>;
  resultProposals: Array<{ id: string; status: string }>;
};

test.afterAll(async () => {
  await stopRestartedE2eServer();
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function createOrganization(request: APIRequestContext, name: string) {
  const response = await request.post("/api/orgs", { data: { name } });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Organization>;
}

async function createAgent(
  request: APIRequestContext,
  orgId: string,
  name: string,
  options: AgentOptions = {},
) {
  const response = await request.post(`/api/orgs/${orgId}/agents`, {
    data: {
      name,
      role: options.role ?? "engineer",
      title: options.title ?? null,
      capabilities: options.capabilities === undefined
        ? "Plan bounded work, execute it, and collect verifiable evidence."
        : options.capabilities,
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.4" },
    },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Agent>;
}

async function createAgentKey(request: APIRequestContext, agentId: string, name: string) {
  const response = await request.post(`/api/agents/${agentId}/keys`, { data: { name } });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ token: string }>;
}

async function previewGoal(
  request: APIRequestContext,
  orgId: string,
  ownerAgentId: string | null,
  title = "Publish a verified Goal Workspace release candidate",
  context: string | null = "The result must be inspectable, restart-safe, and ready for user acceptance.",
) {
  const response = await request.post(`/api/orgs/${orgId}/goals/start-preview`, {
    data: {
      title,
      context,
      ownerAgentId,
      targetTime: "2026-08-20T10:00:00.000Z",
    },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<StartPreview>;
}

async function startGoal(
  request: APIRequestContext,
  orgId: string,
  preview: StartPreview,
  requestKey = randomUUID(),
  draftGoalId?: string,
) {
  expect(preview.valid).toBe(true);
  expect(preview.packet).not.toBeNull();
  expect(preview.packetHash).toMatch(/^[a-f0-9]{64}$/);
  const response = await request.post(`/api/orgs/${orgId}/goals/start`, {
    data: {
      requestKey,
      packetHash: preview.packetHash,
      packet: preview.packet,
      ...(draftGoalId ? { draftGoalId } : {}),
    },
  });
  return { response, goal: response.ok() ? await response.json() as Goal : null };
}

async function selectAgent(page: Page, agentName: string) {
  await page.getByRole("button", { name: /assignee/i }).click();
  await page.getByRole("option", { name: new RegExp(agentName, "i") }).click();
}

test("reveals Goals in the primary rail only after the Experimental setting is enabled", async ({ page }, testInfo: TestInfo) => {
  const resetResponse = await page.request.patch("/api/instance/settings/general", {
    data: { experimentalGoalsEnabled: false },
  });
  expect(resetResponse.ok()).toBe(true);

  const organization = await createOrganization(page.request, `Goal-primary-rail-${Date.now()}`);
  const hiddenGoalResponse = await page.request.post(`/api/orgs/${organization.id}/goals`, {
    data: { title: "Hidden linked Goal" },
  });
  expect(hiddenGoalResponse.status()).toBe(201);
  const hiddenGoal = await hiddenGoalResponse.json() as Goal;
  const projectResponse = await page.request.post(`/api/orgs/${organization.id}/projects`, {
    data: {
      name: "Goal-linked project",
      description: "Exercises the adjacent Project surface.",
      color: "#3b82f6",
      goalIds: [hiddenGoal.id],
    },
  });
  expect(projectResponse.status()).toBe(201);
  const project = await projectResponse.json() as { id: string };
  const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Goal-linked issue",
      status: "todo",
      priority: "medium",
      projectId: project.id,
      goalId: hiddenGoal.id,
    },
  });
  expect(issueResponse.status()).toBe(201);
  const issue = await issueResponse.json() as { id: string; identifier: string | null };

  await page.goto(`/${organization.urlKey}/dashboard`);
  const primaryRail = page.getByTestId("primary-rail");
  await expect(primaryRail).toBeVisible();
  await expect(primaryRail.getByRole("link", { name: "Goals", exact: true })).toHaveCount(0);

  await page.goto(`/${organization.urlKey}/issues/${issue.identifier ?? issue.id}`);
  await expect(page.getByRole("heading", { name: "Goal-linked issue", exact: true })).toBeVisible();
  await expect(page.getByLabel("Open goal")).toHaveCount(0);

  await page.goto(`/${organization.urlKey}/projects/${project.id}/configuration`);
  await expect(page.getByText("Goal-linked project", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Hidden linked Goal", { exact: true })).toHaveCount(0);

  await page.goto(`/${organization.urlKey}/goals`);
  await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/dashboard$`));

  await page.goto("/instance/settings/experimental");
  const goalsToggle = page.getByTestId("experimental-goals-toggle");
  await expect(goalsToggle).toBeVisible();
  await expect(goalsToggle).toHaveAttribute("aria-checked", "false");
  await goalsToggle.click();
  await expect(goalsToggle).toHaveAttribute("aria-checked", "true");

  await page.goto(`/${organization.urlKey}/dashboard`);
  await expect(page.getByTestId("primary-rail").getByRole("link", { name: "Goals", exact: true }))
    .toHaveAttribute("href", `/${organization.urlKey}/goals`);

  await page.goto(`/${organization.urlKey}/issues/${issue.identifier ?? issue.id}`);
  await expect(page.getByLabel("Open goal")).toBeVisible();

  await page.goto(`/${organization.urlKey}/projects/${project.id}/configuration`);
  await expect(page.getByText("Hidden linked Goal", { exact: true })).toBeVisible();

  await page.getByTestId("primary-rail").getByRole("link", { name: "Goals", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/goals$`));
  await expect(page.locator("#main-content").getByRole("heading", { name: "Goals", exact: true }))
    .toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("goal-primary-rail-desktop.png"), fullPage: true });

  await page.reload();
  await expect(page.getByTestId("primary-rail").getByRole("link", { name: "Goals", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByText("Goals", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("goal-primary-rail-mobile.png"), fullPage: true });
});

test.describe("Goal Workspace v2", () => {
  test.beforeEach(async ({ page }) => {
    const response = await page.request.patch("/api/instance/settings/general", {
      data: { experimentalGoalsEnabled: true },
    });
    expect(response.ok()).toBe(true);
  });

  test("creates and starts from one plain-language confirmation, then preserves feedback and progress", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const organization = await createOrganization(page.request, `Goal-workspace-ui-${Date.now()}`);
    const owner = await createAgent(page.request, organization.id, "Workspace owner");
    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.urlKey}/goals`);

    await page.getByRole("button", { name: "New Goal" }).first().click();
    await page.getByRole("textbox", { name: "Goal", exact: true }).fill("Publish a verified Goal Workspace release candidate");
    await page.getByLabel("Context").fill(
      "The result must be inspectable, restart-safe, and ready for user acceptance.",
    );
    await selectAgent(page, owner.name);
    await page.getByLabel("Target time").fill("2026-08-20T10:00");

    await expect(page.getByText("How we will know it worked", { exact: true })).toBeVisible();
    await expect(page.getByText("First action", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Goal start preview").getByText(owner.name, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create and start" })).toBeEnabled();

    await page.getByRole("button", { name: "Create and start" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/goals/[a-f0-9-]+$`));
    await expect(page.getByText("Current Goal", { exact: true })).toBeVisible();
    await expect(page.getByText("Current progress", { exact: true })).toBeVisible();
    await expect(page.getByText("Agent is doing", { exact: true })).toBeVisible();
    await expect(page.getByText("Next step", { exact: true })).toBeVisible();

    for (const hiddenControl of [
      "Objective mode",
      "Evaluator",
      "Evidence references",
      "Allowed autonomy",
      "Human acceptance authority",
      "Initial Plan",
      "Evaluate from evidence",
      "Add activity",
    ]) {
      await expect(page.getByText(hiddenControl, { exact: true })).toHaveCount(0);
    }

    const goalId = page.url().split("/").at(-1)!;
    const contractBeforeFeedback = (await e2eDb.select().from(goals)).find((row) => row.id === goalId)!;
    const feedbackBody = "Keep the release focused on the operator journey, not internal Contract terminology.";
    await page.getByLabel("Goal feedback").fill(feedbackBody);
    await page.getByRole("button", { name: "Send feedback" }).click();
    await expect(page.getByText(feedbackBody, { exact: true })).toBeVisible({ timeout: 30_000 });

    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await expect(page.getByText(feedbackBody, { exact: true })).toBeVisible({ timeout: 30_000 });
    const feedbackRows = (await e2eDb.select().from(goalFeedbackEntries))
      .filter((row) => row.goalId === goalId);
    expect(feedbackRows).toHaveLength(1);
    expect(feedbackRows[0]).toMatchObject({
      actorType: "user",
      body: feedbackBody,
      feedbackKind: "ordinary",
    });
    expect(feedbackRows[0]?.actorId).toBeTruthy();
    const wakeups = (await e2eDb.select().from(agentWakeupRequests)).filter((row) =>
      row.orgId === organization.id
      && row.agentId === owner.id
      && row.idempotencyKey === `goal-feedback:${feedbackRows[0]!.id}`,
    );
    expect(wakeups).toHaveLength(1);

    const contractAfterFeedback = (await e2eDb.select().from(goals)).find((row) => row.id === goalId)!;
    expect(contractAfterFeedback.contractRevision).toBe(contractBeforeFeedback.contractRevision);
    expect(contractAfterFeedback.evaluationResult).toEqual(contractBeforeFeedback.evaluationResult);

    await e2eDb.insert(goalActivities).values({
      orgId: organization.id,
      goalId,
      contractRevision: contractAfterFeedback.contractRevision,
      submittedByAgentId: owner.id,
      agentOwnerRefAtTime: owner.id,
      activityKind: "evidence",
      summary: "The release candidate passed the real operator workflow.",
      evidenceRefs: ["artifact://goal-workspace/e2e-pass"],
      idempotencyKey: `goal-e2e-progress-${goalId}`,
    });
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    const currentProgress = page.getByRole("heading", { name: "Current progress" }).locator("..");
    await expect(currentProgress.getByText(
      "The release candidate passed the real operator workflow.",
      { exact: true },
    )).toBeVisible();
    await expect(currentProgress.getByText("Based on 1 supporting item", { exact: true })).toBeVisible();
    await expect(page.getByText("artifact://goal-workspace/e2e-pass", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Agreement revision", { exact: true })).toHaveCount(0);

    const workspaceResponse = await page.request.get(`/api/goals/${goalId}/workspace`);
    expect(workspaceResponse.ok()).toBe(true);
    const workspace = await workspaceResponse.json() as Workspace;
    expect(workspace.currentProgress.evidenceRefs).toContain("artifact://goal-workspace/e2e-pass");
    expect(workspace.currentProgress.sourceActivityId).toBeTruthy();
    expect(workspace.facet).toBe("agent_advancing");

    await page.screenshot({ path: testInfo.outputPath("goal-workspace-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByText("Current Goal", { exact: true })).toBeVisible();
    await expect(page.getByText("Current progress", { exact: true })).toBeVisible();
    const bodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(bodyOverflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("goal-workspace-mobile.png"), fullPage: true });

    expect(pageErrors).toEqual([]);
  });

  test("keeps Goal Start atomic and replay-safe across validation, conflicts, and restart", async ({ page }) => {
    test.setTimeout(180_000);
    const organization = await createOrganization(page.request, `Goal-start-${Date.now()}`);
    const owner = await createAgent(page.request, organization.id, "Atomic start owner");
    const incapableOwner = await createAgent(page.request, organization.id, "Recruiting coordinator", {
      role: "general",
      capabilities: "Schedules interviews and manages candidate communications.",
    });
    const driftingOwner = await createAgent(page.request, organization.id, "Capability drift owner");
    const otherOrganization = await createOrganization(page.request, `Goal-start-foreign-${Date.now()}`);
    const foreignOwner = await createAgent(page.request, otherOrganization.id, "Foreign owner");

    const unclearPreview = await previewGoal(page.request, organization.id, owner.id, "Explore pricing options", null);
    expect(unclearPreview.valid).toBe(false);
    expect(unclearPreview.packet).toBeNull();
    expect(unclearPreview.alignmentQuestion).toMatch(/observable result or decision/i);

    const draftResponse = await page.request.post(`/api/orgs/${organization.id}/goals`, {
      data: {
        title: "Explore",
        description: "The desired result is not clear yet.",
        ownerAgentId: null,
        alignmentQuestion: unclearPreview.alignmentQuestion,
      },
    });
    expect(draftResponse.status()).toBe(201);
    const draft = await draftResponse.json() as Goal;
    expect(draft.lifecycle).toBe("draft");
    const draftFocus = await page.request.post(`/api/goals/${draft.id}/focus`, {
      data: { focus: true },
    });
    expect(draftFocus.status()).toBe(409);
    expect((await e2eDb.select().from(goalPlans)).filter((row) => row.goalId === draft.id)).toHaveLength(0);
    expect((await e2eDb.select().from(goalActivities)).filter((row) => row.goalId === draft.id)).toHaveLength(0);

    const foreignPreview = await previewGoal(page.request, organization.id, foreignOwner.id);
    expect(foreignPreview.valid).toBe(false);
    expect(foreignPreview.alignmentQuestion).toMatch(/agent|assignee|owner/i);

    const incapablePreview = await previewGoal(page.request, organization.id, incapableOwner.id);
    expect(incapablePreview.valid).toBe(false);
    expect(incapablePreview.alignmentQuestion).toMatch(/better-matched Agent/i);

    const contextPreview = await previewGoal(
      page.request,
      organization.id,
      owner.id,
      "Publish a verified Goal Workspace release candidate",
      "Preserve existing customer data and include a restart check.",
    );
    expect(contextPreview.review?.success).toContain("Preserve existing customer data");

    for (const [title, objectiveMode, evaluator] of [
      ["Increase activation rate by 20%", "maximize", "metric"],
      ["Maintain service uptime above 99.9%", "maintain", "policy"],
      ["Decide which pricing model to launch", "decide", "human"],
    ] as const) {
      const modePreview = await previewGoal(page.request, organization.id, owner.id, title, null);
      expect(modePreview.packet?.activation.objectiveMode).toBe(objectiveMode);
      expect(modePreview.packet?.activation.criteria[0]?.evaluator).toBe(evaluator);
    }

    const driftPreview = await previewGoal(page.request, organization.id, driftingOwner.id);
    expect(driftPreview.valid).toBe(true);
    const capabilityPatch = await page.request.patch(`/api/agents/${driftingOwner.id}`, {
      data: {
        role: "general",
        title: "Recruiting coordinator",
        capabilities: "Schedules interviews and manages candidate communications.",
      },
    });
    expect(capabilityPatch.ok()).toBe(true);
    const driftedStart = await startGoal(page.request, organization.id, driftPreview);
    expect(driftedStart.response.status()).toBe(422);
    expect((await e2eDb.select().from(goalStartRequests)).filter((row) =>
      row.orgId === organization.id && row.packetHash === driftPreview.packetHash,
    )).toHaveLength(0);

    const preview = await previewGoal(page.request, organization.id, owner.id);
    const requestKey = randomUUID();
    const first = await startGoal(page.request, organization.id, preview, requestKey);
    expect(first.response.status()).toBe(201);
    expect(first.goal).toMatchObject({ lifecycle: "active", ownerAgentId: owner.id });

    const focusFirst = await page.request.post(`/api/goals/${first.goal!.id}/focus`, {
      data: { focus: true },
    });
    expect(focusFirst.status()).toBe(200);
    expect((await focusFirst.json() as Goal).focus).toBe(true);

    const secondPreview = await previewGoal(
      page.request,
      organization.id,
      owner.id,
      "Publish a second verified Goal Workspace result",
    );
    const second = await startGoal(page.request, organization.id, secondPreview);
    expect(second.response.status()).toBe(201);
    const focusSecond = await page.request.post(`/api/goals/${second.goal!.id}/focus`, {
      data: { focus: true },
    });
    expect(focusSecond.status()).toBe(200);
    expect((await e2eDb.select().from(goals)).filter((goal) =>
      goal.orgId === organization.id && goal.focus,
    ).map((goal) => goal.id)).toEqual([second.goal!.id]);

    const foreignOwnerKey = await createAgentKey(page.request, foreignOwner.id, "foreign-goal-focus-e2e");
    const foreignFocus = await page.request.post(`/api/goals/${first.goal!.id}/focus`, {
      headers: { Authorization: `Bearer ${foreignOwnerKey.token}` },
      data: { focus: false },
    });
    expect(foreignFocus.status()).toBe(403);

    const replay = await startGoal(page.request, organization.id, preview, requestKey);
    expect(replay.response.ok()).toBe(true);
    expect(replay.goal?.id).toBe(first.goal?.id);

    const changedPreview = await previewGoal(
      page.request,
      organization.id,
      owner.id,
      "Publish a different verified Goal Workspace result",
    );
    const conflictReplay = await startGoal(page.request, organization.id, changedPreview, requestKey);
    expect(conflictReplay.response.status()).toBe(409);

    const goalId = first.goal!.id;
    expect((await e2eDb.select().from(goalStartRequests)).filter((row) =>
      row.orgId === organization.id && row.requestKey === requestKey,
    )).toHaveLength(1);
    expect((await e2eDb.select().from(goalOwnerAssignments)).filter((row) => row.goalId === goalId)).toHaveLength(1);
    expect((await e2eDb.select().from(goalPlans)).filter((row) => row.goalId === goalId)).toHaveLength(1);
    expect((await e2eDb.select().from(goalActivities)).filter((row) => row.goalId === goalId)).toHaveLength(1);

    const tamperedPacket = structuredClone(preview.packet!);
    tamperedPacket.activation.criteria[0]!.label = "Tampered after preview";
    const tamperedResponse = await page.request.post(`/api/orgs/${organization.id}/goals/start`, {
      data: {
        requestKey: randomUUID(),
        packetHash: preview.packetHash,
        packet: tamperedPacket,
      },
    });
    expect([400, 409, 422]).toContain(tamperedResponse.status());

  });

  test("requires governed change approval and human acceptance for every terminal result", async ({ page }) => {
    test.setTimeout(180_000);
    const organization = await createOrganization(page.request, `Goal-governance-${Date.now()}`);
    const owner = await createAgent(page.request, organization.id, "Governed Goal owner");
    const ownerKey = await createAgentKey(page.request, owner.id, "goal-governance-e2e");
    const agentHeaders = { Authorization: `Bearer ${ownerKey.token}` };

    const preview = await previewGoal(page.request, organization.id, owner.id);
    const started = await startGoal(page.request, organization.id, preview);
    expect(started.response.status()).toBe(201);
    const goal = started.goal!;
    const criterionId = preview.packet!.activation.criteria[0]!.id;

    const changeResponse = await page.request.post(`/api/goals/${goal.id}/change-proposals`, {
      headers: agentHeaders,
      data: {
        idempotencyKey: randomUUID(),
        expectedContractRevision: goal.contractRevision,
        rationale: "Evidence shows that the target must explicitly include restart recovery.",
        evidenceRefs: ["artifact://goal-workspace/restart-evidence"],
        afterContract: {
          outcomeStatement: "Publish a verified Goal Workspace release candidate with restart recovery",
        },
      },
    });
    expect(changeResponse.status()).toBe(201);
    const changeProposal = await changeResponse.json() as { approvalId: string; id: string; status: string };
    expect(changeProposal.status).toBe("pending");
    const competingChangeResponse = await page.request.post(`/api/goals/${goal.id}/change-proposals`, {
      headers: agentHeaders,
      data: {
        idempotencyKey: randomUUID(),
        expectedContractRevision: goal.contractRevision,
        rationale: "A competing proposal should be superseded after the accepted revision advances.",
        evidenceRefs: ["artifact://goal-workspace/competing-evidence"],
        afterContract: {
          outcomeStatement: "Publish a competing Goal Workspace release candidate",
        },
      },
    });
    expect(competingChangeResponse.status()).toBe(201);
    const competingChange = await competingChangeResponse.json() as {
      approvalId: string;
      id: string;
      status: string;
    };
    expect(competingChange.status).toBe("pending");
    const beforeApproval = await page.request.get(`/api/goals/${goal.id}`);
    expect((await beforeApproval.json() as Goal).contractRevision).toBe(goal.contractRevision);

    const approveChange = await page.request.post(`/api/approvals/${changeProposal.approvalId}/approve`, {
      data: { decisionNote: "This materially improves the agreed result." },
    });
    expect(approveChange.ok()).toBe(true);
    const changedGoal = await (await page.request.get(`/api/goals/${goal.id}`)).json() as Goal;
    expect(changedGoal.contractRevision).toBe(goal.contractRevision + 1);

    const supersedeCompeting = await page.request.post(`/api/approvals/${competingChange.approvalId}/approve`, {
      data: { decisionNote: "The Goal has already advanced on a different approved revision." },
    });
    expect(supersedeCompeting.status()).toBe(409);
    const competingProposalRow = (await e2eDb.select().from(goalChangeProposals))
      .find((row) => row.id === competingChange.id);
    expect(competingProposalRow?.status).toBe("superseded");
    const competingApprovalRow = (await e2eDb.select().from(approvals))
      .find((row) => row.id === competingChange.approvalId);
    expect(competingApprovalRow?.status).toBe("approved");

    const staleChange = await page.request.post(`/api/goals/${goal.id}/change-proposals`, {
      headers: agentHeaders,
      data: {
        idempotencyKey: randomUUID(),
        expectedContractRevision: goal.contractRevision,
        rationale: "This proposal is intentionally stale.",
        evidenceRefs: ["artifact://goal-workspace/stale"],
        afterContract: { outcomeStatement: "A stale outcome must never be applied" },
      },
    });
    expect(staleChange.status()).toBe(409);

    const inconclusiveKey = randomUUID();
    const inconclusiveResult = await page.request.post(`/api/goals/${goal.id}/result-proposals`, {
      headers: agentHeaders,
      data: {
        idempotencyKey: inconclusiveKey,
        contractRevision: changedGoal.contractRevision,
        evidenceRefs: [],
        criteria: [{ id: criterionId, status: "unknown" }],
        resultPayload: {},
        riskSummary: "The required release evidence is still missing.",
      },
    });
    expect(inconclusiveResult.status()).toBe(201);
    const inconclusiveProposal = await inconclusiveResult.json() as { id: string; status: string; preflight: { outcome: string } };
    expect(inconclusiveProposal.id).toBeTruthy();
    expect(inconclusiveProposal.status).toBe("inconclusive");
    expect(inconclusiveProposal.preflight.outcome).toBe("inconclusive");
    expect((await e2eDb.select().from(goalResultProposals)).filter((row) =>
      row.goalId === goal.id && row.idempotencyKey === inconclusiveKey,
    )).toHaveLength(1);

    const firstResult = await page.request.post(`/api/goals/${goal.id}/result-proposals`, {
      headers: agentHeaders,
      data: {
        idempotencyKey: randomUUID(),
        contractRevision: changedGoal.contractRevision,
        evidenceRefs: ["artifact://goal-workspace/result-v1"],
        criteria: [{ id: criterionId, status: "met" }],
        resultPayload: {},
        riskSummary: "The restart check should be repeated once more.",
      },
    });
    expect(firstResult.status()).toBe(201);
    const firstProposal = await firstResult.json() as { id: string; status: string; preflight: { outcome: string } };
    expect(firstProposal.status).toBe("ready");
    expect(firstProposal.preflight.outcome).toBe("achieved");

    const directTerminalEvaluate = await page.request.post(`/api/goals/${goal.id}/evaluate`, {
      headers: agentHeaders,
      data: {
        evidenceRefs: ["artifact://goal-workspace/direct-agent-close"],
        criteria: [{ id: criterionId, status: "met" }],
        resultPayload: {},
      },
    });
    expect([403, 409, 422]).toContain(directTerminalEvaluate.status());

    const agentSelfAccept = await page.request.post(`/api/goal-result-proposals/${firstProposal.id}/accept`, {
      headers: agentHeaders,
      data: { idempotencyKey: randomUUID() },
    });
    expect(agentSelfAccept.status()).toBe(403);

    const rejectFeedback = "Repeat restart recovery and attach the final runtime identity.";
    const rejectResult = await page.request.post(`/api/goal-result-proposals/${firstProposal.id}/reject`, {
      data: { idempotencyKey: randomUUID(), feedback: rejectFeedback },
    });
    expect(rejectResult.ok()).toBe(true);
    const afterReject = await (await page.request.get(`/api/goals/${goal.id}`)).json() as Goal;
    expect(afterReject.lifecycle).toBe("active");
    expect(afterReject.evaluationResult).toBeNull();
    expect((await e2eDb.select().from(goalFeedbackEntries)).filter((row) =>
      row.goalId === goal.id && row.body === rejectFeedback,
    )).toHaveLength(1);

    const secondResult = await page.request.post(`/api/goals/${goal.id}/result-proposals`, {
      headers: agentHeaders,
      data: {
        idempotencyKey: randomUUID(),
        contractRevision: changedGoal.contractRevision,
        evidenceRefs: ["artifact://goal-workspace/result-v2"],
        criteria: [{ id: criterionId, status: "met" }],
        resultPayload: {},
        riskSummary: "No unresolved release risk remains.",
      },
    });
    expect(secondResult.status()).toBe(201);
    const secondProposal = await secondResult.json() as { id: string; status: string };
    expect(secondProposal.status).toBe("ready");
    const acceptanceKey = randomUUID();
    const [acceptResult, concurrentReplay] = await Promise.all([
      page.request.post(`/api/goal-result-proposals/${secondProposal.id}/accept`, {
        data: { idempotencyKey: acceptanceKey },
      }),
      page.request.post(`/api/goal-result-proposals/${secondProposal.id}/accept`, {
        data: { idempotencyKey: acceptanceKey },
      }),
    ]);
    expect(acceptResult.ok()).toBe(true);
    expect(concurrentReplay.ok()).toBe(true);
    const acceptedGoal = await acceptResult.json() as Goal;
    expect(acceptedGoal.lifecycle).toBe("closed");
    expect(acceptedGoal.status).toBe("achieved");
    expect(acceptedGoal.focus).toBe(false);
    expect(acceptedGoal.evaluationResult?.outcome).toBe("achieved");

    const replayAccept = await page.request.post(`/api/goal-result-proposals/${secondProposal.id}/accept`, {
      data: { idempotencyKey: acceptanceKey },
    });
    expect(replayAccept.ok()).toBe(true);
    expect((await replayAccept.json() as Goal).id).toBe(goal.id);
    const mismatchedReplay = await page.request.post(`/api/goal-result-proposals/${secondProposal.id}/accept`, {
      data: { idempotencyKey: randomUUID() },
    });
    expect(mismatchedReplay.status()).toBe(409);
    const resultRows = (await e2eDb.select().from(goalResultProposals)).filter((row) => row.goalId === goal.id);
    expect(resultRows.filter((proposal) => proposal.consumedAt)).toHaveLength(1);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.urlKey}/goals/${goal.id}`);
    await expect(page.getByText("Result accepted", { exact: true })).toBeVisible();
    await expect(page.getByText("achieved", { exact: true })).toBeVisible();
    await expect(page.getByText("Evaluate from evidence", { exact: true })).toHaveCount(0);
  });

  test("keeps derived board facets read-only and uses an attention list on mobile", async ({ page }) => {
    const organization = await createOrganization(page.request, `Goal-board-${Date.now()}`);
    const owner = await createAgent(page.request, organization.id, "Board owner");
    const preview = await previewGoal(page.request, organization.id, owner.id);
    const started = await startGoal(page.request, organization.id, preview);
    expect(started.response.status()).toBe(201);
    const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Advance the Goal through a real issue",
        status: "in_progress",
        priority: "medium",
        goalId: started.goal!.id,
        assigneeAgentId: owner.id,
      },
    });
    expect(issueResponse.ok()).toBe(true);
    const issue = await issueResponse.json() as { id: string };
    const runId = randomUUID();
    const checkpointTime = new Date();
    await e2eDb.insert(heartbeatRuns).values({
      id: runId,
      orgId: organization.id,
      agentId: owner.id,
      invocationSource: "assignment",
      triggerDetail: "goal_checkpoint_e2e",
      status: "succeeded",
      resultSummaryJson: { summary: "The linked issue produced a reviewable artifact." },
      createdAt: new Date(checkpointTime.getTime() - 1_000),
      updatedAt: checkpointTime,
    });
    await e2eDb.update(issues).set({ executionRunId: runId, updatedAt: new Date(checkpointTime.getTime() - 500) }).where(eq(issues.id, issue.id));

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(`/${organization.urlKey}/goals`);
    await expect(
      page.getByTestId("goal-derived-board").getByText("The linked issue produced a reviewable artifact.", { exact: false }),
    ).toBeVisible();
    await page.getByRole("link", { name: /Publish a verified Goal Workspace release candidate/ }).first().click();
    await expect(page.getByText("Goal details and related work", { exact: true })).toBeVisible();
    await expect(page.getByText("Advance the Goal through a real issue", { exact: true })).toBeVisible();
    await page.goto(`/${organization.urlKey}/goals`);
    for (const facet of ["Agent advancing", "Needs your attention", "Waiting for external result", "Ready for acceptance"]) {
      await expect(page.getByRole("heading", { name: facet })).toBeVisible();
    }
    await expect(page.locator("[draggable=true]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /status/i })).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByTestId("goal-mobile-attention-list")).toBeVisible();
    await expect(page.getByTestId("goal-derived-board")).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("preserves Goal Start and feedback exactly once across a server restart", async ({ page }) => {
    test.setTimeout(180_000);
    const organization = await createOrganization(page.request, `Goal-restart-${Date.now()}`);
    const owner = await createAgent(page.request, organization.id, "Restart owner");
    const preview = await previewGoal(page.request, organization.id, owner.id);
    const requestKey = randomUUID();
    const started = await startGoal(page.request, organization.id, preview, requestKey);
    expect(started.response.status()).toBe(201);
    const goalId = started.goal!.id;
    const feedbackBody = "Keep this feedback and its owner wakeup after restart.";
    const feedbackResponse = await page.request.post(`/api/goals/${goalId}/feedback`, {
      data: {
        body: feedbackBody,
        attachments: [],
        feedbackKind: "ordinary",
        idempotencyKey: randomUUID(),
      },
    });
    expect(feedbackResponse.status()).toBe(201);

    await restartE2eServer();

    const replayAfterRestart = await startGoal(page.request, organization.id, preview, requestKey);
    expect(replayAfterRestart.response.ok()).toBe(true);
    expect(replayAfterRestart.goal?.id).toBe(goalId);
    const workspaceResponse = await page.request.get(`/api/goals/${goalId}/workspace`);
    expect(workspaceResponse.ok()).toBe(true);
    const workspace = await workspaceResponse.json() as Workspace;
    expect(workspace.timeline.some((entry) =>
      entry.kind === "feedback" && entry.summary === feedbackBody,
    )).toBe(true);
    expect((await e2eDb.select().from(goalStartRequests)).filter((row) =>
      row.orgId === organization.id && row.requestKey === requestKey,
    )).toHaveLength(1);
    expect((await e2eDb.select().from(goalOwnerAssignments)).filter((row) => row.goalId === goalId)).toHaveLength(1);
    expect((await e2eDb.select().from(goalPlans)).filter((row) => row.goalId === goalId)).toHaveLength(1);
    expect((await e2eDb.select().from(goalActivities)).filter((row) => row.goalId === goalId)).toHaveLength(1);
    expect((await e2eDb.select().from(goalFeedbackEntries)).filter((row) =>
      row.goalId === goalId && row.body === feedbackBody,
    )).toHaveLength(1);
  });
});
