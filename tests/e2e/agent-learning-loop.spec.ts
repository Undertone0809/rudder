import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { createDb, heartbeatRunEvents, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function createOrganization(request: APIRequestContext, name: string) {
  const orgRes = await request.post("/api/orgs", {
    data: {
      name,
      defaultChatAgentRuntimeType: "codex_local",
      defaultChatAgentRuntimeConfig: {
        model: "gpt-5.4",
      },
    },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function createAgent(request: APIRequestContext, orgId: string) {
  const agentRes = await request.post(`/api/orgs/${orgId}/agents`, {
    data: {
      name: "Learning Loop Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  return agentRes.json() as Promise<{ id: string; name: string; urlKey: string }>;
}

test.describe("Agent learning loop", () => {
  test("turns run feedback into an approved agent learning skill", async ({ page, request }) => {
    const organization = await createOrganization(request, `Agent-Learning-${Date.now()}`);
    const agent = await createAgent(request, organization.id);
    const runId = randomUUID();
    const startedAt = new Date();
    const finishedAt = new Date(startedAt.getTime() + 75_000);

    await e2eDb.insert(heartbeatRuns).values({
      id: runId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      startedAt,
      finishedAt,
      stdoutExcerpt: "Read AGENTS.md before editing. Done.",
      resultJson: {
        kind: "message",
        body: "Read AGENTS.md before editing. Done.",
      },
      contextSnapshot: {
        triggeredBy: "user",
        source: "agent-learning-loop-e2e",
      },
      createdAt: startedAt,
      updatedAt: finishedAt,
    });
    await e2eDb.insert(heartbeatRunEvents).values({
      orgId: organization.id,
      runId,
      agentId: agent.id,
      seq: 1,
      eventType: "adapter.invoke",
      stream: "system",
      level: "info",
      message: "adapter invocation",
      payload: {
        prompt: "Use [$skill-creator](/skills/skill-creator/SKILL.md) and [$skill-optimizer](/skills/skill-optimizer/SKILL.md).",
        loadedSkills: [
          { key: "skill-creator", runtimeName: "skill-creator", name: "skill-creator" },
          { key: "skill-optimizer", runtimeName: "skill-optimizer", name: "skill-optimizer" },
        ],
      },
      createdAt: startedAt,
    });

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/agents/${agent.id}/runs/${runId}`, { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Learning Loop Agent" })).toBeVisible({ timeout: 15_000 });
    const loadedSkillsCard = page.getByText("Skills used in this run").locator("xpath=ancestor::section[1]");
    await expect(loadedSkillsCard).toBeVisible();
    await expect(loadedSkillsCard.getByText("2 skills recorded for this run.")).toBeVisible();

    await loadedSkillsCard.getByRole("button", { name: "Give feedback" }).click();
    const feedbackDialog = page.getByRole("dialog", { name: "Give feedback" });
    await expect(feedbackDialog).toBeVisible();
    await feedbackDialog.getByLabel("Feedback").fill(
      "Before editing in this repo, read AGENTS.md and the project instructions so future code changes follow the repository conventions.",
    );
    await feedbackDialog.getByRole("button", { name: "Improve future runs" }).click();

    await expect(page).toHaveURL(/\/agents\/[^/]+\/learnings\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { name: "Review AI-generated skill update" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("AI proposal: update Learning")).toBeVisible();
    await expect(page.getByText("Read project instructions before editing")).toBeVisible();
    await expect(page.getByText("AGENTS.md", { exact: false })).toBeVisible();

    await page.getByRole("button", { name: "Apply AI proposal" }).first().click();

    await expect(page).toHaveURL(/\/agents\/[^/]+\/learning$/);
    await expect(page.getByText("Pending AI updates")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Feedback records")).toBeVisible();
    await expect(page.getByText("Read project instructions before editing")).toBeVisible();
    await expect(page.getByText("Learning", { exact: true }).first()).toBeVisible();

    const summaryRes = await request.get(
      `/api/orgs/${organization.id}/agents/${agent.id}/learnings/summary`,
    );
    expect(summaryRes.ok()).toBe(true);
    const summary = await summaryRes.json() as {
      activeLearnings: Array<{ title: string; instruction: string }>;
      managedSkill: { name: string } | null;
      recentFeedbackItems: Array<{ body: string }>;
    };
    expect(summary.managedSkill?.name).toBe("Learning");
    expect(summary.activeLearnings.map((learning) => learning.title)).toContain(
      "Read project instructions before editing",
    );
    expect(summary.recentFeedbackItems.map((item) => item.body)).toContain(
      "Before editing in this repo, read AGENTS.md and the project instructions so future code changes follow the repository conventions.",
    );

    const skillsRes = await request.get(`/api/agents/${agent.id}/skills?orgId=${organization.id}`);
    expect(skillsRes.ok()).toBe(true);
    const skillSnapshot = await skillsRes.json() as { desiredSkills: string[] };
    expect(skillSnapshot.desiredSkills.some((key) => key.startsWith("agent:") && key.includes("agent-learning"))).toBe(true);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/skills`, { waitUntil: "domcontentloaded" });
    const managedLearningCard = page.getByText("Agent learning", { exact: true }).locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
    await expect(managedLearningCard.getByText("Learning", { exact: true })).toBeVisible();
    await expect(managedLearningCard.getByRole("link", { name: "Open learning" })).toBeVisible();
    await expect(page.getByText("agent-learning-learning-loop-agent")).toHaveCount(0);
    await managedLearningCard.getByRole("link", { name: "Open learning" }).click();
    await expect(page).toHaveURL(/\/agents\/[^/]+\/learning$/);

    await page.screenshot({
      path: "/tmp/rudder-agent-learning-loop-learning.png",
      fullPage: true,
    });
  });
});
