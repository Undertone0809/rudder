import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";
import { restartE2eServer, stopRestartedE2eServer } from "./support/restart-e2e-server";

const e2eDb = createDb(E2E_DATABASE_URL);

type Organization = {
  id: string;
  issuePrefix: string;
};

type Agent = {
  id: string;
  name: string;
};

type Goal = {
  id: string;
  title: string;
  orgId: string;
  parentId: string | null;
  ownerAgentId: string | null;
  lifecycle: string;
  status: string;
  focus: boolean;
  planRevision: number;
  continuationKind: string | null;
  continuationSummary: string | null;
  wakeCondition: string | null;
  evaluationResult: { outcome?: string } | null;
  plan?: { revision: number; summary: string } | null;
  activities?: Array<{ id: string; summary: string; idempotencyKey: string | null }>;
};

test.afterAll(async () => {
  await stopRestartedE2eServer();
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function createOrganization(page: Page, name: string) {
  const response = await page.request.post("/api/orgs", { data: { name } });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Organization>;
}

async function createAgent(page: Page, orgId: string, name: string) {
  const response = await page.request.post(`/api/orgs/${orgId}/agents`, {
    data: { name, role: "engineer", agentRuntimeType: "codex_local", agentRuntimeConfig: { model: "gpt-5.4" } },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Agent>;
}

async function createGoal(page: Page, orgId: string, title: string) {
  const response = await page.request.post(`/api/orgs/${orgId}/goals`, {
    data: {
      title,
      description: "A production-shaped Goal contract fixture.",
      status: "active",
      level: "organization",
      parentId: null,
    },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Goal>;
}

function activationPayload(ownerAgentId: string, suffix: string, overrides: Record<string, unknown> = {}) {
  return {
    confirmed: true,
    ownerAgentId,
    outcomeStatement: `The verified external outcome ${suffix} is available`,
    objectiveMode: "target",
    criteria: [{ id: "outcome", label: "The verified outcome exists", evaluator: "artifact" }],
    autonomyEnvelope: { allowed: ["bounded_work"] },
    humanAuthorities: { acceptance: "operator" },
    evaluationPolicy: { terminalEvidenceRequired: true },
    initialContinuation: { kind: "verification", summary: "Verify the next bounded result" },
    initialPlan: { summary: `Build and verify ${suffix}` },
    ...overrides,
  };
}

test.describe("Goal contract lifecycle", () => {
  test("runs Draft to evaluated Proof through the user workflow", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto("/");

    const organization = await createOrganization(page, `Goal-contract-${Date.now()}`);
    const owner = await createAgent(page, organization.id, "Goal contract owner");
    const nonOwner = await createAgent(page, organization.id, "Goal contract non-owner");
    const otherOrganization = await createOrganization(page, `Goal-contract-other-${Date.now()}`);
    const otherOrganizationOwner = await createAgent(page, otherOrganization.id, "Other organization owner");
    const goal = await createGoal(page, organization.id, "Deliver the verified Goal result");
    const otherGoal = await createGoal(page, otherOrganization.id, "Foreign organization Goal");

    expect(goal.lifecycle).toBe("draft");
    expect(goal.status).toBe("planned");
    expect(goal.parentId).toBeNull();
    expect(goal.ownerAgentId).toBeNull();

    const keyResponse = await page.request.post(`/api/agents/${owner.id}/keys`, { data: { name: "goal-boundary-e2e" } });
    expect(keyResponse.ok()).toBe(true);
    const key = await keyResponse.json() as { token: string };
    const nonOwnerKeyResponse = await page.request.post(`/api/agents/${nonOwner.id}/keys`, { data: { name: "goal-non-owner-e2e" } });
    expect(nonOwnerKeyResponse.ok()).toBe(true);
    const nonOwnerKey = await nonOwnerKeyResponse.json() as { token: string };
    const foreignGoalResponse = await page.request.get(`/api/goals/${otherGoal.id}`, {
      headers: { Authorization: `Bearer ${key.token}` },
    });
    expect(foreignGoalResponse.status()).toBe(403);

    const incompleteActivation = await page.request.post(`/api/goals/${goal.id}/activate`, { data: { confirmed: false } });
    expect(incompleteActivation.status()).toBe(400);

    const crossOrganizationActivation = await page.request.post(`/api/goals/${goal.id}/activate`, {
      data: activationPayload(otherOrganizationOwner.id, "cross-organization rejection"),
    });
    expect(crossOrganizationActivation.status()).toBe(422);

    const directStatusPatch = await page.request.patch(`/api/goals/${goal.id}`, { data: { status: "achieved" } });
    expect(directStatusPatch.status()).toBe(400);

    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);
    await page.goto(`/${organization.issuePrefix}/goals/${goal.id}`);
    await expect(page.getByText("Contract activation", { exact: true })).toBeVisible();
    await expect(page.getByText("Draft contract has no outcome statement.", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Activity summary")).toHaveCount(0);

    await page.getByLabel("Agent Owner").selectOption(owner.id);
    await page.getByLabel("Continuation").selectOption("verification");
    await page.getByLabel("Outcome statement").fill("The verified external outcome is available");
    await page.getByLabel("First next step").fill("Verify the next bounded result");
    await page.getByLabel("Initial Plan").fill("Build and verify the first result");
    await page.getByRole("button", { name: "Confirm activation" }).click();
    await expect(page.getByText("Contract activation", { exact: true })).toHaveCount(0);
    await expect(page.getByText("The verified external outcome is available", { exact: true })).toBeVisible();
    await expect(page.getByText("Verify the next bounded result", { exact: true })).toBeVisible();
    await expect(page.getByText("Revision 1", { exact: true })).toBeVisible();
    const activatedDetail = await (await page.request.get(`/api/goals/${goal.id}?_=${Date.now()}`)).json() as Goal;
    expect(activatedDetail.activities?.some((activity) => activity.summary.includes("Verify the next bounded result"))).toBe(true);
    expect(activatedDetail.continuationKind).toBe("verification");
    expect(activatedDetail.continuationSummary).toBe("Verify the next bounded result");
    expect(activatedDetail.wakeCondition).toBeNull();

    const nonOwnerPlanResponse = await page.request.post(`/api/goals/${goal.id}/plan`, {
      headers: { Authorization: `Bearer ${nonOwnerKey.token}` },
      data: { summary: "A non-owner must not revise this Goal" },
    });
    expect(nonOwnerPlanResponse.status()).toBe(403);
    const nonOwnerActivityResponse = await page.request.post(`/api/goals/${goal.id}/activities`, {
      headers: { Authorization: `Bearer ${nonOwnerKey.token}` },
      data: { summary: "A non-owner must not add activity", evidenceRefs: ["artifact://non-owner"] },
    });
    expect(nonOwnerActivityResponse.status()).toBe(403);
    const nonOwnerOwnerResponse = await page.request.post(`/api/goals/${goal.id}/owner`, {
      headers: { Authorization: `Bearer ${nonOwnerKey.token}` },
      data: { agentId: owner.id, authorityRef: "non-owner-attempt" },
    });
    expect(nonOwnerOwnerResponse.status()).toBe(403);
    const nonOwnerFocusResponse = await page.request.post(`/api/goals/${goal.id}/focus`, {
      headers: { Authorization: `Bearer ${nonOwnerKey.token}` },
      data: { focus: true },
    });
    expect(nonOwnerFocusResponse.status()).toBe(403);
    const nonOwnerEvaluateResponse = await page.request.post(`/api/goals/${goal.id}/evaluate`, {
      headers: { Authorization: `Bearer ${nonOwnerKey.token}` },
      data: { evidenceRefs: ["artifact://non-owner"], criteria: [{ id: "outcome", status: "met" }] },
    });
    expect(nonOwnerEvaluateResponse.status()).toBe(403);

    await page.getByRole("button", { name: "Set focus" }).click();
    await expect(page.getByText("Focus Goal", { exact: true })).toBeVisible();

    await page.getByLabel("Plan revision").fill("Verify the result, then preserve the evidence trail");
    await page.getByRole("button", { name: "Save revision" }).click();
    await expect(page.getByText("Revision 2", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("paragraph").filter({ hasText: "Verify the result, then preserve the evidence trail" }),
    ).toBeVisible();

    await page.getByLabel("Activity summary").fill("Operator confirmed the first bounded commitment");
    await page.getByRole("button", { name: "Add activity" }).click();
    await expect(page.getByText("Operator confirmed the first bounded commitment", { exact: true })).toBeVisible();

    const unboundCloseoutResponse = await page.request.post(`/api/goals/${goal.id}/activities`, {
      data: {
        summary: "Closeout without a Run",
        activityKind: "closeout",
        evidenceRefs: ["artifact://unbound-closeout"],
      },
    });
    expect(unboundCloseoutResponse.status()).toBe(400);

    const terminalRunId = randomUUID();
    await e2eDb.insert(heartbeatRuns).values({
      id: terminalRunId,
      orgId: organization.id,
      agentId: owner.id,
      invocationSource: "on_demand",
      triggerDetail: "goal-closeout-e2e",
      status: "succeeded",
      startedAt: new Date("2026-08-04T00:10:00.000Z"),
      finishedAt: new Date("2026-08-04T00:11:00.000Z"),
      resultJson: { summary: "The terminal Goal-linked Run completed" },
      resultSummaryJson: { summary: "The terminal Goal-linked Run completed" },
      createdAt: new Date("2026-08-04T00:10:00.000Z"),
      updatedAt: new Date("2026-08-04T00:11:00.000Z"),
    });
    const closeoutPayload = {
      summary: "Terminal Run closeout with verified evidence",
      activityKind: "closeout",
      runRef: terminalRunId,
      evidenceRefs: ["run://terminal-closeout"],
    };
    const closeoutResponse = await page.request.post(`/api/goals/${goal.id}/activities`, { data: closeoutPayload });
    expect(closeoutResponse.status()).toBe(201);
    const duplicateCloseoutResponse = await page.request.post(`/api/goals/${goal.id}/activities`, {
      data: { ...closeoutPayload, idempotencyKey: "closeout-retry-with-new-key" },
    });
    expect(duplicateCloseoutResponse.status()).toBe(409);

    const duplicateActivityPayload = {
      summary: "Idempotent evidence marker",
      activityKind: "evidence",
      evidenceRefs: ["artifact://goal-contract"],
      idempotencyKey: "goal-contract-evidence-1",
    };
    const firstActivityResponse = await page.request.post(`/api/goals/${goal.id}/activities`, { data: duplicateActivityPayload });
    const firstActivity = await firstActivityResponse.json() as { id: string };
    expect(firstActivityResponse.status()).toBe(201);
    const retryActivityResponse = await page.request.post(`/api/goals/${goal.id}/activities`, { data: duplicateActivityPayload });
    const retryActivity = await retryActivityResponse.json() as { id: string };
    expect(retryActivityResponse.status()).toBe(201);
    expect(retryActivity.id).toBe(firstActivity.id);

    const secondGoal = await createGoal(page, organization.id, "Secondary focus candidate");
    const secondActivation = await page.request.post(`/api/goals/${secondGoal.id}/activate`, {
      data: activationPayload(owner.id, "secondary focus candidate", {
        criteria: [
          { id: "outcome", label: "The secondary outcome exists", evaluator: "artifact" },
          { id: "safety", label: "The secondary result stays safe", evaluator: "policy" },
        ],
      }),
    });
    expect(secondActivation.ok()).toBe(true);
    const secondFocus = await page.request.post(`/api/goals/${secondGoal.id}/focus`, { data: { focus: true } });
    expect(secondFocus.ok()).toBe(true);
    const firstAfterFocusSwitch = await (await page.request.get(`/api/goals/${goal.id}`)).json() as Goal;
    const secondAfterFocusSwitch = await (await page.request.get(`/api/goals/${secondGoal.id}`)).json() as Goal;
    expect(firstAfterFocusSwitch.focus).toBe(false);
    expect(secondAfterFocusSwitch.focus).toBe(true);

    await page.getByLabel("Evidence reference").fill("artifact://goal-contract-proof");
    await page.getByLabel("Criterion result: The desired external outcome is true").selectOption("met");
    await page.getByRole("button", { name: "Evaluate from evidence" }).click();
    await expect(page.getByText("Proof", { exact: true })).toBeVisible();
    await expect(page.getByText("achieved", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Activity summary")).toHaveCount(0);
    await expect(page.getByText("Evaluation is derived from the submitted evidence and cannot be edited as a status.", { exact: true })).toBeVisible();
    await expect(page.locator('[aria-live="polite"] li')).toHaveCount(1);

    const detailResponse = await page.request.get(`/api/goals/${goal.id}?_=${Date.now()}`);
    expect(detailResponse.ok()).toBe(true);
    const detail = await detailResponse.json() as Goal;
    expect(detail.lifecycle).toBe("closed");
    expect(detail.status).toBe("achieved");
    expect(detail.evaluationResult?.outcome).toBe("achieved");
    expect(detail.plan?.revision).toBe(2);
    expect(detail.activities?.filter((activity) => activity.idempotencyKey === "goal-contract-evidence-1")).toHaveLength(1);

    await restartE2eServer();
    const afterRestart = await (await page.request.get(`/api/goals/${goal.id}?restart=${Date.now()}`)).json() as Goal;
    expect(afterRestart.lifecycle).toBe("closed");
    expect(afterRestart.continuationSummary).toBe("Verify the next bounded result");
    await page.reload();
    await expect(page.getByText("Proof", { exact: true })).toBeVisible();
    await expect(page.getByText("Verify the next bounded result", { exact: true })).toBeVisible();

    await page.locator("#main-content").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: testInfo.outputPath("goal-contract-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByText("Proof", { exact: true })).toBeVisible();
    await expect(page.getByText("Operator confirmed the first bounded commitment", { exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("goal-contract-mobile.png"), fullPage: true });

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(`/${organization.issuePrefix}/goals/${secondGoal.id}`);
    await expect(page.getByLabel("Criterion result: The secondary outcome exists")).toBeVisible();
    await expect(page.getByLabel("Criterion result: The secondary result stays safe")).toBeVisible();
    await page.getByLabel("Criterion result: The secondary outcome exists").selectOption("met");
    await page.getByLabel("Criterion result: The secondary result stays safe").selectOption("unmet");
    await page.getByLabel("Evidence reference").fill("artifact://secondary-goal-proof");
    await page.getByRole("button", { name: "Evaluate from evidence" }).click();
    await expect(page.getByText("not_achieved", { exact: true })).toBeVisible();
    const secondaryDetail = await (await page.request.get(`/api/goals/${secondGoal.id}?_=${Date.now()}`)).json() as Goal;
    expect(secondaryDetail.evaluationResult?.outcome).toBe("not_achieved");
    expect(pageErrors).toEqual([]);
  });

  test("evaluates every objective mode through the public Goal API", async ({ page }) => {
    const organization = await createOrganization(page, `Goal-evaluator-modes-${Date.now()}`);
    const owner = await createAgent(page, organization.id, "Evaluator mode owner");
    const cases = [
      { mode: "target", expected: "achieved", criteria: [{ id: "result", label: "Result exists", evaluator: "artifact", evidenceRequirements: ["artifact://goal-target"] }], evaluation: { criteria: [{ id: "result", status: "met" }] } },
      { mode: "maximize", expected: "completed_with_result", criteria: [{ id: "result", label: "Result is measurable", evaluator: "metric" }], evaluation: { criteria: [{ id: "result", status: "met" }], resultValue: 42 } },
      { mode: "maximize", expected: "inconclusive", criteria: [{ id: "result", label: "Result is measurable", evaluator: "metric" }, { id: "safety", label: "Result remains safe", evaluator: "policy" }], evaluation: { criteria: [{ id: "result", status: "met" }, { id: "safety", status: "unmet" }], resultValue: 42 } },
      { mode: "maintain", expected: "breached", criteria: [{ id: "result", label: "Boundary stays intact", evaluator: "policy" }], evaluation: { criteria: [{ id: "result", status: "breached" }] } },
      { mode: "decide", expected: "decided", criteria: [{ id: "result", label: "Decision evidence is sufficient", evaluator: "human" }], evaluation: { criteria: [{ id: "result", status: "met" }], decision: "Choose path B" } },
      { mode: "decide", expected: "inconclusive", criteria: [{ id: "result", label: "Decision evidence is sufficient", evaluator: "human" }, { id: "safety", label: "Decision remains safe", evaluator: "policy" }], evaluation: { criteria: [{ id: "result", status: "met" }, { id: "safety", status: "breached" }], decision: "Choose path B" } },
    ] as const;

    for (const testCase of cases) {
      const goal = await createGoal(page, organization.id, `Evaluate ${testCase.mode}`);
      const activation = await page.request.post(`/api/goals/${goal.id}/activate`, {
        data: activationPayload(owner.id, testCase.mode, { objectiveMode: testCase.mode, criteria: testCase.criteria }),
      });
      expect(activation.ok()).toBe(true);
      const evaluation = await page.request.post(`/api/goals/${goal.id}/evaluate`, {
        data: { evidenceRefs: [`artifact://goal-${testCase.mode}`], ...testCase.evaluation },
      });
      expect(evaluation.ok()).toBe(true);
      const evaluated = await evaluation.json() as Goal;
      expect(evaluated.evaluationResult?.outcome).toBe(testCase.expected);
    }
  });

  test("evaluates target Goals through the UI for metric and human criteria", async ({ page }) => {
    await page.goto("/");
    const organization = await createOrganization(page, `Goal-ui-evaluator-${Date.now()}`);
    const owner = await createAgent(page, organization.id, "UI evaluator owner");
    const cases = [
      {
        evaluator: "metric",
        label: "The target result is measurable",
        valueLabel: "Observed result",
        value: "42",
      },
      {
        evaluator: "human",
        label: "The target result is approved",
        valueLabel: "Human decision",
        value: "Approve the verified path",
      },
    ] as const;

    for (const testCase of cases) {
      const goal = await createGoal(page, organization.id, `UI target ${testCase.evaluator}`);
      const activation = await page.request.post(`/api/goals/${goal.id}/activate`, {
        data: activationPayload(owner.id, `UI ${testCase.evaluator}`, {
          criteria: [{ id: "result", label: testCase.label, evaluator: testCase.evaluator }],
        }),
      });
      expect(activation.ok()).toBe(true);

      await page.evaluate((orgId) => {
        window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      }, organization.id);
      await page.goto(`/${organization.issuePrefix}/goals/${goal.id}`);
      await page.getByLabel(`Criterion result: ${testCase.label}`).selectOption("met");
      await page.getByLabel(testCase.valueLabel).fill(testCase.value);
      await page.getByLabel("Evidence reference").fill(`artifact://ui-${testCase.evaluator}`);
      await page.getByRole("button", { name: "Evaluate from evidence" }).click();
      await expect(page.getByText("achieved", { exact: true })).toBeVisible();
    }
  });
});
