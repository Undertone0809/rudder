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
  warning: string | null;
};

type Workspace = {
  goal: Goal;
  facet: string;
  currentProgress: {
    summary: string;
    sourceActivityId: string | null;
    evidenceRefs: string[];
  };
  agentAction: { summary: string; sourceIds: string[] } | null;
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
  await expect(page.getByText("Hidden linked Goal", { exact: true })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await expect(page.getByRole("link", { name: "Goals", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Close sidebar" }).click({ position: { x: 360, y: 100 } });
  await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 960 });

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

  const otherOrganization = await createOrganization(page.request, `Goal-route-owner-${Date.now()}`);
  const otherGoalResponse = await page.request.post(`/api/orgs/${otherOrganization.id}/goals`, {
    data: { title: "Goal owned by another organization" },
  });
  expect(otherGoalResponse.status()).toBe(201);
  const otherGoal = await otherGoalResponse.json() as Goal;
  await page.goto(`/${organization.urlKey}/goals/${otherGoal.id}`);
  await expect(page).toHaveURL(new RegExp(`/${otherOrganization.urlKey}/goals/${otherGoal.id}$`));
  await expect(page.getByRole("heading", { name: otherGoal.title, exact: true })).toBeVisible();
  await page.goto(`/${organization.urlKey}/goals`);

  await page.reload();
  await expect(page.getByTestId("primary-rail").getByRole("link", { name: "Goals", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "Open sidebar" }).click();
  const mobileGoalsLink = page.getByRole("link", { name: "Goals", exact: true });
  await expect(mobileGoalsLink).toBeVisible();
  await expect(mobileGoalsLink).toHaveAttribute("href", `/${organization.urlKey}/goals`);
  await expect(mobileGoalsLink).toHaveAttribute("aria-current", "page");
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
    const ownerKey = await createAgentKey(page.request, owner.id, "goal-workspace-owner-run");
    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.setViewportSize({ width: 1440, height: 960 });
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

    const createAndStart = page.getByRole("button", { name: "Create and start" });
    const buttonReceivesPointer = await createAndStart.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === button || Boolean(hit && button.contains(hit));
    });
    expect(buttonReceivesPointer).toBe(true);
    await createAndStart.click();
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
    const startRequest = (await e2eDb.select().from(goalStartRequests)).find((row) => row.goalId === goalId)!;
    const startWakeups = (await e2eDb.select().from(agentWakeupRequests)).filter((row) =>
      row.orgId === organization.id
      && row.agentId === owner.id
      && row.idempotencyKey === `goal-start:${startRequest.id}`,
    );
    expect(startWakeups).toHaveLength(1);
    expect(startWakeups[0]?.source).toBe("on_demand");
    expect(startWakeups[0]?.triggerDetail).toBe("system");
    expect(startWakeups[0]?.runId).toBeTruthy();
    expect((await e2eDb.select().from(heartbeatRuns)).find((run) =>
      run.id === startWakeups[0]?.runId && run.wakeupRequestId === startWakeups[0]?.id,
    )).toBeTruthy();
    const contractBeforeFeedback = (await e2eDb.select().from(goals)).find((row) => row.id === goalId)!;
    const feedbackBody = "Keep the release focused on the operator journey, not internal Contract terminology.";
    let feedbackAttempts = 0;
    await page.route(`**/api/goals/${goalId}/feedback`, async (route) => {
      feedbackAttempts += 1;
      if (feedbackAttempts === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Temporary feedback outage" }),
        });
        return;
      }
      await route.continue();
    });
    const feedbackInput = page.getByLabel("Goal feedback");
    await feedbackInput.fill(feedbackBody);
    const sendFeedback = page.getByRole("button", { name: "Send feedback" });
    await sendFeedback.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toContainText("Temporary feedback outage");
    await expect(page.getByText(feedbackBody, { exact: true })).toBeVisible();
    await expect(feedbackInput).toBeFocused();

    const retryFeedback = page.getByRole("button", { name: "Retry feedback" });
    await retryFeedback.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(feedbackBody, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(feedbackInput).toBeFocused();
    expect(feedbackAttempts).toBe(2);
    await page.unroute(`**/api/goals/${goalId}/feedback`);

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
    expect(wakeups[0]?.source).toBe("on_demand");
    expect(wakeups[0]?.triggerDetail).toBe("system");
    expect(wakeups[0]?.runId).toBeTruthy();
    expect((await e2eDb.select().from(heartbeatRuns)).find((run) =>
      run.id === wakeups[0]?.runId && run.wakeupRequestId === wakeups[0]?.id,
    )).toBeTruthy();

    const contractAfterFeedback = (await e2eDb.select().from(goals)).find((row) => row.id === goalId)!;
    expect(contractAfterFeedback.contractRevision).toBe(contractBeforeFeedback.contractRevision);
    expect(contractAfterFeedback.evaluationResult).toEqual(contractBeforeFeedback.evaluationResult);

    const progressExternalEvidence = `https://evidence.rudder.dev/goals/${goalId}/operator-workflow`;
    const progressLibraryPath = `goals/${goalId}/operator-workflow.md`;
    const progressLibraryFileEvidence = `library-file://file?p=${encodeURIComponent(progressLibraryPath)}`;
    const progressArtifactEvidence = "artifact://goal-workspace/e2e-pass";
    const libraryFileResponse = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: progressLibraryPath,
        content: "# Operator workflow evidence\n\nThe real Goal lifecycle completed successfully.\n",
      },
    });
    expect(libraryFileResponse.ok()).toBe(true);

    const ownerRunId = wakeups[0]!.runId!;
    const goalRuns = (await e2eDb.select().from(heartbeatRuns)).filter((run) => {
      const context = run.contextSnapshot as Record<string, unknown> | null;
      return run.orgId === organization.id
        && run.agentId === owner.id
        && context?.goalId === goalId;
    });
    for (const run of goalRuns) {
      await e2eDb.update(heartbeatRuns).set({ status: "succeeded", updatedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    }
    const progressResponse = await page.request.post(`/api/goals/${goalId}/activities`, {
      headers: {
        Authorization: `Bearer ${ownerKey.token}`,
        "x-rudder-run-id": ownerRunId,
      },
      data: {
        activityKind: "evidence",
        summary: "The release candidate passed the real operator workflow.",
        evidenceRefs: [progressExternalEvidence, progressLibraryFileEvidence, progressArtifactEvidence],
        idempotencyKey: `goal-e2e-progress-${goalId}`,
      },
    });
    expect(progressResponse.status()).toBe(201);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    const currentProgress = page.getByRole("heading", { name: "Current progress" }).locator("..");
    await expect(currentProgress.getByText(
      "The release candidate passed the real operator workflow.",
      { exact: true },
    )).toBeVisible();
    const progressEvidence = currentProgress.getByLabel("Supporting evidence");
    const progressExternalLink = progressEvidence.getByRole("link", { name: /^External link evidence 1/ });
    await expect(progressExternalLink).toHaveAttribute("href", progressExternalEvidence);
    await expect(progressExternalLink).toHaveAttribute("target", "_blank");
    await expect(progressExternalLink).toHaveAttribute("rel", /\bnoopener\b/);
    await expect(progressExternalLink).toHaveAttribute("rel", /\bnoreferrer\b/);
    const progressLibraryLink = progressEvidence.getByRole("link", {
      name: `Library file: ${progressLibraryPath} Open`,
      exact: true,
    });
    await expect(progressLibraryLink).toHaveAttribute(
      "href",
      `/${organization.urlKey}/library?path=${encodeURIComponent(progressLibraryPath)}`,
    );
    const progressArtifactRow = progressEvidence.getByText("Artifact evidence 3", { exact: true }).locator("..");
    await expect(progressArtifactRow.getByText("Unavailable", { exact: true })).toBeVisible();
    await expect(page.getByText(progressArtifactEvidence, { exact: true })).toHaveCount(0);
    await expect(page.getByText("Agreement revision", { exact: true })).toHaveCount(0);

    await progressLibraryLink.click();
    await expect(page).toHaveURL(new RegExp(
      `/${organization.urlKey}/library\\?path=${encodeURIComponent(progressLibraryPath)}$`,
    ));
    await expect(page.locator("#main-content")).toContainText("operator-workflow.md");
    await page.goto(`/${organization.urlKey}/goals/${goalId}`);
    await expect(page.getByRole("heading", { name: "Current progress", exact: true })).toBeVisible();

    const workspaceResponse = await page.request.get(`/api/goals/${goalId}/workspace`);
    expect(workspaceResponse.ok()).toBe(true);
    const workspace = await workspaceResponse.json() as Workspace;
    expect(workspace.currentProgress.evidenceRefs).toEqual([
      progressExternalEvidence,
      progressLibraryFileEvidence,
      progressArtifactEvidence,
    ]);
    expect(workspace.currentProgress.sourceActivityId).toBeTruthy();
    expect(workspace.agentAction?.sourceIds).toContain(ownerRunId);
    expect(workspace.facet).toBe("agent_advancing");
    expect((await e2eDb.select().from(goalActivities)).find((row) =>
      row.id === workspace.currentProgress.sourceActivityId
      && row.runRef === ownerRunId
      && row.submittedByAgentId === owner.id,
    )).toBeTruthy();

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
        ownerAgentId: owner.id,
        targetTime: "2026-08-20T10:00:00.000Z",
        alignmentQuestion: unclearPreview.alignmentQuestion,
      },
    });
    expect(draftResponse.status()).toBe(201);
    const draft = await draftResponse.json() as Goal;
    expect(draft.lifecycle).toBe("draft");
    expect(draft.ownerAgentId).toBe(owner.id);
    const persistedDraft = (await e2eDb.select().from(goals)).find((row) => row.id === draft.id)!;
    expect(persistedDraft.evaluationDeadline?.toISOString()).toBe("2026-08-20T10:00:00.000Z");
    const draftFocus = await page.request.post(`/api/goals/${draft.id}/focus`, {
      data: { focus: true },
    });
    expect(draftFocus.status()).toBe(409);
    expect((await e2eDb.select().from(goalPlans)).filter((row) => row.goalId === draft.id)).toHaveLength(0);
    expect((await e2eDb.select().from(goalActivities)).filter((row) => row.goalId === draft.id)).toHaveLength(0);

    const foreignDraftResponse = await page.request.post(`/api/orgs/${organization.id}/goals`, {
      data: {
        title: "Keep a foreign Owner out of this Draft",
        ownerAgentId: foreignOwner.id,
      },
    });
    expect(foreignDraftResponse.status()).toBe(422);

    const foreignPreview = await previewGoal(page.request, organization.id, foreignOwner.id);
    expect(foreignPreview.valid).toBe(false);
    expect(foreignPreview.alignmentQuestion).toMatch(/agent|assignee|owner/i);

    const incapablePreview = await previewGoal(page.request, organization.id, incapableOwner.id);
    expect(incapablePreview.valid).toBe(true);
    expect(incapablePreview.warning).toMatch(/not be the best match|choose another Agent/i);

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

  test("requires governed change approval and human acceptance for every terminal result", async ({ page }, testInfo) => {
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

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.urlKey}/messenger/approvals/${changeProposal.approvalId}`);
    const changeApprovalDialog = page.getByTestId("approval-detail-dialog");
    await expect(changeApprovalDialog.getByLabel("Goal change summary")).toBeVisible();
    await expect(changeApprovalDialog.getByText(
      "Publish a verified Goal Workspace release candidate with restart recovery",
      { exact: true },
    )).toBeVisible();
    for (const internalDetail of ["objectiveMode", "autonomyEnvelope", "evaluationPolicy", "artifact://"]) {
      await expect(changeApprovalDialog.getByText(internalDetail, { exact: false })).toHaveCount(0);
    }
    await changeApprovalDialog.getByTestId("approval-decision-note").fill("This materially improves the agreed result.");
    const approveChange = changeApprovalDialog.getByRole("button", { name: "Approve", exact: true });
    await approveChange.focus();
    await expect(approveChange).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(changeApprovalDialog.getByText("Approval confirmed", { exact: true })).toBeVisible();
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
    expect(competingApprovalRow?.status).toBe("cancelled");

    const rejectedChangeResponse = await page.request.post(`/api/goals/${goal.id}/change-proposals`, {
      headers: agentHeaders,
      data: {
        idempotencyKey: randomUUID(),
        expectedContractRevision: changedGoal.contractRevision,
        rationale: "This broadens the commitment beyond the agreed release boundary and should be rejected.",
        evidenceRefs: ["artifact://goal-workspace/unwanted-expansion"],
        afterContract: {
          outcomeStatement: "Publish the Goal Workspace and redesign every adjacent product surface",
        },
      },
    });
    expect(rejectedChangeResponse.status()).toBe(201);
    const rejectedChange = await rejectedChangeResponse.json() as { approvalId: string; id: string; status: string };
    await page.goto(`/${organization.urlKey}/messenger/approvals/${rejectedChange.approvalId}`);
    const rejectApprovalDialog = page.getByTestId("approval-detail-dialog");
    await expect(rejectApprovalDialog.getByLabel("Goal change summary")).toBeVisible();
    await expect(rejectApprovalDialog).not.toContainText(rejectedChange.approvalId);
    await expect(rejectApprovalDialog).not.toContainText(rejectedChange.id);
    await expect(rejectApprovalDialog).not.toContainText(goal.id);
    await page.setViewportSize({ width: 390, height: 844 });
    const approvalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(approvalOverflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("goal-change-approval-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });
    await rejectApprovalDialog.getByTestId("approval-decision-note").fill("Keep the Goal limited to the agreed operator workflow.");
    const rejectChange = rejectApprovalDialog.getByRole("button", { name: "Reject", exact: true });
    await rejectChange.focus();
    await expect(rejectChange).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(async () => {
      const row = (await e2eDb.select().from(goalChangeProposals)).find((proposal) => proposal.id === rejectedChange.id);
      return row?.status;
    }).toBe("rejected");
    expect((await page.request.get(`/api/goals/${goal.id}`).then((response) => response.json()) as Goal).contractRevision)
      .toBe(changedGoal.contractRevision);

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
    await page.goto(`/${organization.urlKey}/goals/${goal.id}`);
    const firstResultProposal = page.getByLabel("Goal result proposal");
    await expect(firstResultProposal).toBeVisible();
    await expect(firstResultProposal.getByText("The restart check should be repeated once more.", { exact: true })).toBeVisible();
    await expect(firstResultProposal.getByText("artifact://goal-workspace/result-v1", { exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    const proposalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(proposalOverflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("goal-result-proposal-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });

    await firstResultProposal.getByLabel("Why is this result not sufficient?").fill(rejectFeedback);
    const rejectResult = firstResultProposal.getByRole("button", { name: "Result is not sufficient" });
    await rejectResult.focus();
    await expect(rejectResult).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(firstResultProposal).toHaveCount(0);
    await expect(page.getByText("Result proposal rejected", { exact: true })).toBeVisible();
    await expect(page.getByText(rejectFeedback, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Current Goal", exact: true })).toBeFocused();
    const afterReject = await (await page.request.get(`/api/goals/${goal.id}`)).json() as Goal;
    expect(afterReject.lifecycle).toBe("active");
    expect(afterReject.evaluationResult).toBeNull();
    const rejectionFeedbackRows = (await e2eDb.select().from(goalFeedbackEntries)).filter((row) =>
      row.goalId === goal.id && row.body === rejectFeedback,
    );
    expect(rejectionFeedbackRows).toHaveLength(1);
    const rejectionWakeup = (await e2eDb.select().from(agentWakeupRequests)).find((row) =>
      row.idempotencyKey === `goal-feedback:${rejectionFeedbackRows[0]!.id}`,
    );
    expect(rejectionWakeup?.runId).toBeTruthy();
    expect((await e2eDb.select().from(heartbeatRuns)).find((run) =>
      run.id === rejectionWakeup?.runId && run.wakeupRequestId === rejectionWakeup?.id,
    )).toBeTruthy();
    await page.reload();
    await expect(page.getByText(rejectFeedback, { exact: true })).toBeVisible();

    const resultExternalEvidence = `https://evidence.rudder.dev/goals/${goal.id}/accepted-result`;
    const resultLibraryPath = `goals/${goal.id}/accepted-result.md`;
    const resultLibraryFileResponse = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: resultLibraryPath,
        content: "# Accepted result evidence\n\nRestart recovery and runtime identity are verified.\n",
      },
    });
    expect(resultLibraryFileResponse.ok()).toBe(true);
    const resultLibraryFile = await resultLibraryFileResponse.json() as { libraryEntryId: string };
    expect(resultLibraryFile.libraryEntryId).toBeTruthy();
    const resultLibraryEntryEvidence = [
      `library-entry://${resultLibraryFile.libraryEntryId}`,
      `p=${encodeURIComponent(resultLibraryPath)}`,
    ].join("?");
    const resultArtifactEvidence = "artifact://goal-workspace/result-v2";
    const resultEvidenceRefs = [resultExternalEvidence, resultLibraryEntryEvidence, resultArtifactEvidence];
    const secondResult = await page.request.post(`/api/goals/${goal.id}/result-proposals`, {
      headers: agentHeaders,
      data: {
        idempotencyKey: randomUUID(),
        contractRevision: changedGoal.contractRevision,
        evidenceRefs: resultEvidenceRefs,
        criteria: [{ id: criterionId, status: "met" }],
        resultPayload: {},
        riskSummary: "No unresolved release risk remains.",
      },
    });
    expect(secondResult.status()).toBe(201);
    const secondProposal = await secondResult.json() as { id: string; status: string };
    expect(secondProposal.status).toBe("ready");
    const pendingAtClosureResponse = await page.request.post(`/api/goals/${goal.id}/change-proposals`, {
      headers: agentHeaders,
      data: {
        idempotencyKey: randomUUID(),
        expectedContractRevision: changedGoal.contractRevision,
        rationale: "This proposal must close without remaining actionable after result acceptance.",
        evidenceRefs: ["artifact://goal-workspace/pending-at-close"],
        afterContract: {
          outcomeStatement: "Publish the verified Goal Workspace after one additional optional review",
        },
      },
    });
    expect(pendingAtClosureResponse.status()).toBe(201);
    const pendingAtClosure = await pendingAtClosureResponse.json() as { approvalId: string; id: string; status: string };
    expect(pendingAtClosure.status).toBe("pending");
    const unsupportedGoalRevision = await page.request.post(`/api/approvals/${pendingAtClosure.approvalId}/request-revision`, {
      data: { decisionNote: "Use rejection feedback and submit a new Goal update instead." },
    });
    expect(unsupportedGoalRevision.status()).toBe(422);
    await page.reload();
    const secondResultProposal = page.getByLabel("Goal result proposal");
    await expect(secondResultProposal).toBeVisible();
    await expect(secondResultProposal.getByText("No unresolved release risk remains.", { exact: true })).toBeVisible();
    const proposedResultEvidence = secondResultProposal.getByLabel("Inspectable result evidence");
    const proposedExternalLink = proposedResultEvidence.getByRole("link", { name: /^External link evidence 1/ });
    await expect(proposedExternalLink).toHaveAttribute("href", resultExternalEvidence);
    await expect(proposedExternalLink).toHaveAttribute("target", "_blank");
    await expect(proposedExternalLink).toHaveAttribute("rel", /\bnoopener\b/);
    await expect(proposedExternalLink).toHaveAttribute("rel", /\bnoreferrer\b/);
    const proposedLibraryEntryLink = proposedResultEvidence.getByRole("link", {
      name: `Library entry: ${resultLibraryPath} Open`,
      exact: true,
    });
    const resultLibraryHref = [
      `/${organization.urlKey}/library?entry=${encodeURIComponent(resultLibraryFile.libraryEntryId)}`,
      `path=${encodeURIComponent(resultLibraryPath)}`,
    ].join("&");
    await expect(proposedLibraryEntryLink).toHaveAttribute("href", resultLibraryHref);
    const proposedArtifactRow = proposedResultEvidence.getByText("Artifact evidence 3", { exact: true }).locator("..");
    await expect(proposedArtifactRow.getByText("Unavailable", { exact: true })).toBeVisible();
    await expect(page.getByText(resultArtifactEvidence, { exact: true })).toHaveCount(0);

    await proposedLibraryEntryLink.click();
    await expect(page).toHaveURL(new RegExp(
      `/${organization.urlKey}/library\\?path=${encodeURIComponent(resultLibraryPath)}$`,
    ));
    await expect(page.locator("#main-content")).toContainText("accepted-result.md");
    await page.goto(`/${organization.urlKey}/goals/${goal.id}`);
    const reloadedResultProposal = page.getByLabel("Goal result proposal");
    await expect(reloadedResultProposal).toBeVisible();
    const acceptResult = reloadedResultProposal.getByRole("button", { name: "Accept result" });
    await acceptResult.focus();
    await expect(acceptResult).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Result accepted", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();
    const acceptedResult = page.getByLabel("Accepted Goal result");
    await expect(acceptedResult.getByText("Goal achieved", { exact: true })).toBeVisible();
    await expect(acceptedResult.getByText(preview.review!.success, { exact: true })).toBeVisible();
    await expect(acceptedResult.getByText("No unresolved release risk remains.", { exact: true })).toBeVisible();
    await expect(acceptedResult.getByText("Evidence check", { exact: true })).toBeVisible();
    const acceptedResultEvidence = acceptedResult.getByLabel("Inspectable result evidence");
    const acceptedExternalLink = acceptedResultEvidence.getByRole("link", { name: /^External link evidence 1/ });
    await expect(acceptedExternalLink).toHaveAttribute("href", resultExternalEvidence);
    await expect(acceptedExternalLink).toHaveAttribute("target", "_blank");
    await expect(acceptedExternalLink).toHaveAttribute("rel", /\bnoopener\b/);
    await expect(acceptedExternalLink).toHaveAttribute("rel", /\bnoreferrer\b/);
    await expect(acceptedResultEvidence.getByRole("link", {
      name: `Library entry: ${resultLibraryPath} Open`,
      exact: true,
    })).toHaveAttribute("href", resultLibraryHref);
    const acceptedArtifactRow = acceptedResultEvidence.getByText("Artifact evidence 3", { exact: true }).locator("..");
    await expect(acceptedArtifactRow.getByText("Unavailable", { exact: true })).toBeVisible();
    await expect(page.getByText(resultArtifactEvidence, { exact: true })).toHaveCount(0);
    const acceptedProgress = page.getByRole("heading", { name: "Current progress", exact: true }).locator("..");
    await expect(acceptedProgress.getByText("Goal achieved", { exact: true })).toBeVisible();
    await expect(acceptedProgress.getByText("Goal evaluated as", { exact: false })).toHaveCount(0);
    await expect(page.getByText("No evidence-backed progress has been recorded yet.", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Agent advancing", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Agent is doing", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Next step", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Goal feedback")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Rename" })).toHaveCount(0);
    await expect(page.getByText(`Goal updated after approval: ${changeProposal.rationale}`, { exact: true })).toBeVisible();
    for (const internalTerm of ["Goal Contract", "Contract revision", "change_proposal", "result_proposal"]) {
      await expect(page.getByText(internalTerm, { exact: false })).toHaveCount(0);
    }
    await expect(page.getByRole("heading", { name: "Current Goal", exact: true })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("goal-result-accepted-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const acceptedOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(acceptedOverflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("goal-result-accepted-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 960 });

    const acceptedGoal = await (await page.request.get(`/api/goals/${goal.id}`)).json() as Goal;
    expect(acceptedGoal.lifecycle).toBe("closed");
    expect(acceptedGoal.status).toBe("achieved");
    expect(acceptedGoal.focus).toBe(false);
    expect(acceptedGoal.evaluationResult?.outcome).toBe("achieved");
    const pendingAtClosureProposalRow = (await e2eDb.select().from(goalChangeProposals))
      .find((row) => row.id === pendingAtClosure.id);
    const pendingAtClosureApprovalRow = (await e2eDb.select().from(approvals))
      .find((row) => row.id === pendingAtClosure.approvalId);
    expect(pendingAtClosureProposalRow?.status).toBe("superseded");
    expect(pendingAtClosureApprovalRow?.status).toBe("cancelled");
    const revisionAfterClose = await page.request.post(`/api/approvals/${pendingAtClosure.approvalId}/request-revision`, {
      data: { decisionNote: "This closed Goal must remain terminal." },
    });
    expect(revisionAfterClose.status()).toBe(422);
    const resubmitAfterClose = await page.request.post(`/api/approvals/${pendingAtClosure.approvalId}/resubmit`, {
      data: {},
    });
    expect(resubmitAfterClose.status()).toBe(422);

    const closedPatch = await page.request.patch(`/api/goals/${goal.id}`, {
      data: {
        title: "Rewrite an accepted Goal",
        description: "Closed Goal history must remain immutable.",
      },
    });
    expect(closedPatch.status()).toBe(409);
    const unchangedClosedGoal = await (await page.request.get(`/api/goals/${goal.id}`)).json() as Goal;
    expect(unchangedClosedGoal.title).toBe(goal.title);

    await e2eDb.update(goalChangeProposals).set({ status: "pending" })
      .where(eq(goalChangeProposals.id, competingChange.id));
    const closedWorkspaceResponse = await page.request.get(`/api/goals/${goal.id}/workspace`);
    expect(closedWorkspaceResponse.ok()).toBe(true);
    expect((await closedWorkspaceResponse.json() as Workspace).attention).toBeNull();
    const historyCardsResponse = await page.request.get(`/api/orgs/${organization.id}/goals/workspace`);
    expect(historyCardsResponse.ok()).toBe(true);
    const historyCards = await historyCardsResponse.json() as Array<{
      id: string;
      facet: string;
      attentionReason: string | null;
    }>;
    expect(historyCards.find((card) => card.id === goal.id)).toMatchObject({
      facet: "closed",
      attentionReason: null,
    });

    const acceptedProposalRow = (await e2eDb.select().from(goalResultProposals))
      .find((proposal) => proposal.id === secondProposal.id)!;
    expect(acceptedProposalRow.acceptanceIdempotencyKey).toBeTruthy();
    const acceptanceKey = acceptedProposalRow.acceptanceIdempotencyKey!;

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

    await page.reload();
    await expect(page.getByText("Result accepted", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Accepted Goal result").getByText("Goal achieved", { exact: true })).toBeVisible();
    await expect(page.getByText("Evaluate from evidence", { exact: true })).toHaveCount(0);

    const negativePreview = await previewGoal(
      page.request,
      organization.id,
      owner.id,
      "Verify a Goal result that did not meet its release criterion",
      "The acceptance workflow must show the failed criterion and supporting evidence before the user decides.",
    );
    const negativeStarted = await startGoal(page.request, organization.id, negativePreview);
    expect(negativeStarted.response.status()).toBe(201);
    const negativeGoal = negativeStarted.goal!;
    const negativeCriterionId = negativePreview.packet!.activation.criteria[0]!.id;
    const negativeResultResponse = await page.request.post(`/api/goals/${negativeGoal.id}/result-proposals`, {
      headers: agentHeaders,
      data: {
        idempotencyKey: randomUUID(),
        contractRevision: negativeGoal.contractRevision,
        evidenceRefs: ["artifact://goal-workspace/failed-release-check"],
        criteria: [{ id: negativeCriterionId, status: "unmet" }],
        resultPayload: {},
        riskSummary: "The release criterion failed, so accepting this result closes the Goal without claiming success.",
      },
    });
    expect(negativeResultResponse.status()).toBe(201);
    expect((await negativeResultResponse.json() as { status: string }).status).toBe("ready");

    await page.goto(`/${organization.urlKey}/goals/${negativeGoal.id}`);
    const negativeResultProposal = page.getByLabel("Goal result proposal");
    await expect(negativeResultProposal).toBeVisible();
    await expect(negativeResultProposal.getByText("Goal not achieved", { exact: true })).toBeVisible();
    await expect(negativeResultProposal.getByText("Not met", { exact: true })).toBeVisible();
    await expect(negativeResultProposal.getByText("Evidence check", { exact: true })).toBeVisible();
    await expect(negativeResultProposal.getByText(
      "The submitted evidence supports closing this Goal as not achieved.",
      { exact: true },
    )).toBeVisible();
    await expect(negativeResultProposal.getByText("Artifact evidence 1", { exact: true })).toBeVisible();
    await expect(negativeResultProposal.getByText("artifact://goal-workspace/failed-release-check", { exact: true })).toHaveCount(0);
    const readyForReviewLabels = page.getByText("Result ready for review", { exact: true });
    await expect(readyForReviewLabels).toHaveCount(2);
    await expect(readyForReviewLabels.first()).toBeVisible();
    await expect(readyForReviewLabels.last()).toBeVisible();
    for (const internalTerm of ["result_proposal", "not_achieved"]) {
      await expect(page.getByText(internalTerm, { exact: false })).toHaveCount(0);
    }
    await page.screenshot({ path: testInfo.outputPath("goal-negative-result-desktop.png"), fullPage: true });

    const acceptNegativeResult = negativeResultProposal.getByRole("button", { name: "Accept result" });
    await acceptNegativeResult.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Result accepted", { exact: true })).toBeVisible();
    const acceptedNegativeGoal = await (await page.request.get(`/api/goals/${negativeGoal.id}`)).json() as Goal;
    expect(acceptedNegativeGoal.lifecycle).toBe("closed");
    expect(acceptedNegativeGoal.status).toBe("cancelled");
    expect(acceptedNegativeGoal.evaluationResult?.outcome).toBe("not_achieved");
  });

  test("keeps one ready Result Proposal per Goal under concurrent submissions", async ({ page }) => {
    test.setTimeout(180_000);
    const organization = await createOrganization(page.request, `Goal-result-concurrency-${Date.now()}`);
    const owner = await createAgent(page.request, organization.id, "Concurrent result owner");
    const agentKey = await createAgentKey(page.request, owner.id, "goal-result-concurrency-e2e");
    const preview = await previewGoal(page.request, organization.id, owner.id);
    const started = await startGoal(page.request, organization.id, preview);
    expect(started.response.status()).toBe(201);
    const goal = started.goal!;
    const criterionId = preview.packet!.activation.criteria[0]!.id;
    const headers = { Authorization: `Bearer ${agentKey.token}` };
    const terminalPayload = (idempotencyKey: string) => ({
      idempotencyKey,
      contractRevision: goal.contractRevision,
      evidenceRefs: ["artifact://goal-workspace/concurrent-result"],
      criteria: [{ id: criterionId, status: "met" }],
      resultPayload: {},
      riskSummary: "Concurrent submissions must converge on one reviewable result.",
    });

    const sharedKey = randomUUID();
    const identicalResponses = await Promise.all(Array.from({ length: 8 }, () => (
      page.request.post(`/api/goals/${goal.id}/result-proposals`, {
        headers,
        data: terminalPayload(sharedKey),
      })
    )));
    expect(identicalResponses.every((response) => response.status() === 201)).toBe(true);
    const identicalProposals = await Promise.all(identicalResponses.map((response) => (
      response.json() as Promise<{ id: string }>
    )));
    expect(new Set(identicalProposals.map((proposal) => proposal.id))).toEqual(new Set([identicalProposals[0]!.id]));
    expect((await e2eDb.select().from(goalResultProposals)).filter((row) => row.goalId === goal.id)).toHaveLength(1);

    const firstProposalId = identicalProposals[0]!.id;
    const rejectResponse = await page.request.post(`/api/goal-result-proposals/${firstProposalId}/reject`, {
      data: {
        idempotencyKey: randomUUID(),
        feedback: "Use a fresh concurrent round to prove the ready-result invariant.",
      },
    });
    expect(rejectResponse.ok()).toBe(true);

    const distinctTerminalRequests = Array.from({ length: 8 }, () => (
      page.request.post(`/api/goals/${goal.id}/result-proposals`, {
        headers,
        data: terminalPayload(randomUUID()),
      })
    ));
    const inconclusiveRequest = page.request.post(`/api/goals/${goal.id}/result-proposals`, {
      headers,
      data: {
        idempotencyKey: randomUUID(),
        contractRevision: goal.contractRevision,
        evidenceRefs: [],
        criteria: [{ id: criterionId, status: "unknown" }],
        resultPayload: {},
        riskSummary: "This concurrent proposal intentionally remains inconclusive.",
      },
    });
    const [distinctTerminalResponses, inconclusiveResponse] = await Promise.all([
      Promise.all(distinctTerminalRequests),
      inconclusiveRequest,
    ]);
    expect(distinctTerminalResponses.filter((response) => response.status() === 201)).toHaveLength(1);
    expect(distinctTerminalResponses.filter((response) => response.status() === 409)).toHaveLength(7);
    expect(inconclusiveResponse.status()).toBe(201);

    const rows = (await e2eDb.select().from(goalResultProposals)).filter((row) => row.goalId === goal.id);
    expect(rows.filter((row) => row.status === "ready")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "inconclusive")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "rejected")).toHaveLength(1);
    const ready = rows.find((row) => row.status === "ready")!;
    const workspaceResponse = await page.request.get(`/api/goals/${goal.id}/workspace`);
    expect(workspaceResponse.ok()).toBe(true);
    const workspace = await workspaceResponse.json() as Workspace;
    expect(workspace.attention).toMatchObject({ kind: "result_proposal", sourceId: ready.id });
    expect(workspace.resultProposals.filter((proposal) => proposal.status === "ready")).toHaveLength(1);
  });

  test("keeps derived board facets read-only and uses an attention list on mobile", async ({ page }) => {
    const organization = await createOrganization(page.request, `Goal-board-${Date.now()}`);
    const longHistoryToken = `history-${"x".repeat(160)}`;
    const longAttachmentName = `acceptance-${"y".repeat(160)}.txt`;
    const owner = await createAgent(page.request, organization.id, `Board-owner-${"z".repeat(120)}`);
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
    const [progressActivity] = await e2eDb.insert(goalActivities).values({
      orgId: organization.id,
      goalId: started.goal!.id,
      contractRevision: started.goal!.contractRevision,
      submittedByAgentId: owner.id,
      agentOwnerRefAtTime: owner.id,
      activityKind: "evidence",
      runRef: runId,
      summary: "The release artifact passed the acceptance workflow.",
      evidenceRefs: ["artifact://goal-workspace/acceptance-pass"],
      idempotencyKey: `goal-board-evidence-${started.goal!.id}`,
      occurredAt: new Date(Date.now() - 60_000),
    }).returning();
    await e2eDb.insert(goalActivities).values(Array.from({ length: 101 }, (_, index) => ({
      orgId: organization.id,
      goalId: started.goal!.id,
      contractRevision: started.goal!.contractRevision,
      submittedByAgentId: owner.id,
      agentOwnerRefAtTime: owner.id,
      activityKind: (["decision_requested", "bottleneck"] as const)[index % 2],
      summary: `Excluded current-progress event ${index + 1}`,
      evidenceRefs: [`artifact://goal-workspace/excluded-${index + 1}`],
      idempotencyKey: `goal-board-excluded-${started.goal!.id}-${index + 1}`,
      runRef: null,
      occurredAt: new Date(Date.now() + index),
    })));
    await e2eDb.insert(goalFeedbackEntries).values({
      orgId: organization.id,
      goalId: started.goal!.id,
      actorType: "user",
      actorId: "history-overflow-user",
      body: longHistoryToken,
      attachments: [{
        name: longAttachmentName,
        uri: `asset://${randomUUID()}`,
        mimeType: "text/plain",
        size: 256,
      }],
      contentHash: randomUUID(),
      feedbackKind: "ordinary",
      idempotencyKey: `goal-board-overflow-${started.goal!.id}`,
      createdAt: new Date(Date.now() - 120_000),
      updatedAt: new Date(Date.now() - 120_000),
    });
    const startedRuns = (await e2eDb.select().from(heartbeatRuns)).filter((run) => {
      const context = run.contextSnapshot as Record<string, unknown> | null;
      return run.orgId === organization.id && context?.goalId === started.goal!.id;
    });
    for (const run of startedRuns) {
      await e2eDb.update(heartbeatRuns).set({ status: "succeeded", updatedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    }
    await e2eDb.update(issues).set({ executionRunId: runId, updatedAt: new Date(checkpointTime.getTime() - 500) }).where(eq(issues.id, issue.id));

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(`/${organization.urlKey}/goals`);
    await expect(
      page.getByTestId("goal-derived-board").getByText("The release artifact passed the acceptance workflow.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByTestId("goal-derived-board").getByText("The linked issue produced a reviewable artifact.", { exact: false }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: /Publish a verified Goal Workspace release candidate/ }).first().click();
    const workspaceResponse = await page.request.get(`/api/goals/${started.goal!.id}/workspace`);
    expect(workspaceResponse.ok()).toBe(true);
    const workspace = await workspaceResponse.json() as Workspace;
    expect((await page.request.get(`/api/goals/${started.goal!.id}/history?cursor=not-a-cursor`)).status()).toBe(400);
    const foreignOrganization = await createOrganization(page.request, `Goal-history-foreign-${Date.now()}`);
    const foreignAgent = await createAgent(page.request, foreignOrganization.id, "Foreign history reader");
    const foreignKey = await createAgentKey(page.request, foreignAgent.id, "Foreign history key");
    expect((await page.request.get(`/api/goals/${started.goal!.id}/history`, {
      headers: { Authorization: `Bearer ${foreignKey.token}` },
    })).status()).toBe(403);
    expect(workspace.currentProgress).toMatchObject({
      sourceActivityId: progressActivity!.id,
      summary: "The release artifact passed the acceptance workflow.",
    });
    const currentProgress = page.getByRole("heading", { name: "Current progress", exact: true }).locator("..");
    await expect(currentProgress.getByText("The release artifact passed the acceptance workflow.", { exact: true })).toBeVisible();
    const agentAction = page.getByRole("heading", { name: /^(Agent is doing|Latest Agent activity)$/ }).locator("..");
    await expect(agentAction.getByText("The linked issue produced a reviewable artifact.", { exact: false })).toBeVisible();
    const history = page.getByRole("heading", { name: "Progress and feedback", exact: true }).locator("..");
    await expect(history.getByText("Excluded current-progress event 101", { exact: true })).toBeVisible();
    await expect(history.getByText("Excluded current-progress event 1", { exact: true })).toHaveCount(0);
    let loadEarlier = history.getByRole("button", { name: "Load earlier records" });
    await loadEarlier.focus();
    for (const [index, expectedFirstLoaded] of ["Excluded current-progress event 51", "Excluded current-progress event 1"].entries()) {
      await page.keyboard.press("Enter");
      await expect(history.getByText(expectedFirstLoaded, { exact: true })).toBeVisible();
      await expect(history.getByText(expectedFirstLoaded, { exact: true }).locator("..")).toBeFocused();
      if (index === 0) {
        loadEarlier = history.getByRole("button", { name: "Load earlier records" });
        await page.keyboard.press("Tab");
        await expect(loadEarlier).toBeFocused();
      }
    }
    await expect(history.getByText("The release artifact passed the acceptance workflow.", { exact: true })).toBeVisible();
    await expect(history.getByRole("button", { name: "Load earlier records" })).toHaveCount(0);
    await expect(history.getByText("The linked issue produced a reviewable artifact.", { exact: false })).toHaveCount(0);
    for (const internalKind of ["work_status", "activity", "Related work"]) {
      await expect(history.getByText(internalKind, { exact: true })).toHaveCount(0);
    }
    await expect(page.getByText("Goal details and related work", { exact: true })).toBeVisible();
    await expect(page.getByText("Advance the Goal through a real issue", { exact: true })).toBeVisible();
    await expect(history.getByText(longHistoryToken, { exact: true })).toBeVisible();
    await expect(history.getByText(longAttachmentName, { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    const detailOverflow = await page.getByTestId("goal-detail-workspace").evaluate((root) => {
      const rootRect = root.getBoundingClientRect();
      return [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))].flatMap((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return [];
        const escapesRoot = rect.left < rootRect.left - 1 || rect.right > rootRect.right + 1;
        const clipsContent = element.scrollWidth > element.clientWidth + 1
          && style.overflowX !== "auto"
          && style.overflowX !== "scroll";
        return escapesRoot || clipsContent
          ? [{ tag: element.tagName, text: element.textContent?.slice(0, 80), escapesRoot, clipsContent }]
          : [];
      });
    });
    expect(detailOverflow).toEqual([]);
    await page.setViewportSize({ width: 1440, height: 960 });

    const setFocus = page.getByRole("button", { name: "Set focus", exact: true });
    await setFocus.focus();
    await page.keyboard.press("Enter");
    const unfocus = page.getByRole("button", { name: "Unfocus", exact: true });
    await expect(unfocus).toBeVisible();
    await expect(unfocus).toBeFocused();
    expect((await page.request.get(`/api/goals/${started.goal!.id}`).then((response) => response.json()) as Goal).focus)
      .toBe(true);
    await page.reload();
    await expect(unfocus).toBeVisible();
    await unfocus.focus();
    await page.keyboard.press("Enter");
    await expect(setFocus).toBeVisible();
    await expect(setFocus).toBeFocused();
    expect((await page.request.get(`/api/goals/${started.goal!.id}`).then((response) => response.json()) as Goal).focus)
      .toBe(false);

    await page.goto(`/${organization.urlKey}/goals`);
    for (const facet of ["Agent advancing", "Needs your attention", "Waiting to start", "Waiting for external result", "Ready for acceptance"]) {
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

  test("makes Focus a durable Run admission boundary and resumes after Focus moves", async ({ page }) => {
    test.setTimeout(180_000);
    const organization = await createOrganization(page.request, `Goal-focus-admission-${Date.now()}`);
    const owner = await createAgent(page.request, organization.id, "Focus admission owner");
    const firstPreview = await previewGoal(
      page.request,
      organization.id,
      owner.id,
      "Ship the focused Goal result",
    );
    const first = await startGoal(page.request, organization.id, firstPreview);
    expect(first.response.status()).toBe(201);
    expect((await page.request.post(`/api/goals/${first.goal!.id}/focus`, {
      data: { focus: true },
    })).status()).toBe(200);

    const secondPreview = await previewGoal(
      page.request,
      organization.id,
      owner.id,
      "Ship the queued Goal result after Focus moves",
    );
    const second = await startGoal(page.request, organization.id, secondPreview);
    expect(second.response.status()).toBe(201);
    const secondWakeup = (await e2eDb.select().from(agentWakeupRequests))
      .find((wakeup) => (wakeup.payload as Record<string, unknown> | null)?.goalId === second.goal!.id);
    expect(secondWakeup).toMatchObject({
      status: "deferred_goal_focus",
      runId: null,
      error: "goal.focused_elsewhere",
    });
    const waitingWorkspace = await page.request.get(`/api/goals/${second.goal!.id}/workspace`)
      .then((response) => response.json()) as Workspace;
    expect(waitingWorkspace.facet).toBe("waiting_focus");
    expect(waitingWorkspace.attention).toBeNull();

    await page.goto(`/${organization.urlKey}/goals/${second.goal!.id}`);
    await expect(page.getByText("Waiting to start", { exact: true })).toBeVisible();
    const setFocus = page.getByRole("button", { name: "Set focus", exact: true });
    await setFocus.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Unfocus", exact: true })).toBeFocused();
    await expect(page.getByText("Agent advancing", { exact: true })).toBeVisible();
    await expect.poll(async () => (
      await e2eDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, secondWakeup!.id))
    ).length).toBe(1);
    await page.reload();
    await expect(page.getByText("Agent advancing", { exact: true })).toBeVisible();
    expect((await e2eDb.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, secondWakeup!.id)))).toHaveLength(1);
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
