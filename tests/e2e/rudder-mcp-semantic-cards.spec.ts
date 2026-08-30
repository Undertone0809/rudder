import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  approvals,
  automations,
  chatConversations,
  chatMessages,
  createDb,
  goals,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
} from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

interface SemanticEntities {
  goalIds: string[];
  issueId: string;
  issueRef: string;
  approvalIssueId: string;
  approvalIssueRef: string;
  commentId: string;
  projectId: string;
  approvalId: string;
  automationId: string;
  triggerId: string;
}

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function seedOrganizationAndAgent(page: Page, label: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `${label}-${Date.now()}`,
      issuePrefix: `MC${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };
  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Semantic Card Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.4" },
    },
  });
  expect(agentRes.ok(), await agentRes.text()).toBe(true);
  const agent = await agentRes.json() as { id: string };
  const goalIds = Array.from({ length: 13 }, () => randomUUID());
  const projectId = randomUUID();
  const issueId = randomUUID();
  const approvalIssueId = randomUUID();
  const commentId = randomUUID();
  const approvalId = randomUUID();
  const automationId = randomUUID();
  const triggerId = randomUUID();
  const issueRef = `${organization.issuePrefix}-42`;
  const approvalIssueRef = `${organization.issuePrefix}-84`;

  await e2eDb.insert(goals).values(goalIds.map((id, index) => ({
    id,
    orgId: organization.id,
    title: `Goal ${index + 1}: semantic transcript coverage`,
    lifecycle: "active",
    status: "active",
    ownerAgentId: agent.id,
  })));
  await e2eDb.insert(projects).values({
    id: projectId,
    orgId: organization.id,
    name: "MCP Cards",
    status: "in_progress",
    leadAgentId: agent.id,
  });
  await e2eDb.insert(issues).values([
    {
      id: issueId,
      orgId: organization.id,
      projectId,
      title: "Semantic card comment target",
      identifier: issueRef,
      issueNumber: 42,
      status: "in_progress",
      assigneeAgentId: agent.id,
    },
    {
      id: approvalIssueId,
      orgId: organization.id,
      projectId,
      title: "Review deployment plan",
      identifier: approvalIssueRef,
      issueNumber: 84,
      status: "in_review",
      reviewerAgentId: agent.id,
    },
  ]);
  await e2eDb.insert(issueComments).values({
    id: commentId,
    orgId: organization.id,
    issueId,
    authorAgentId: agent.id,
    body: "Card-ready comment",
  });
  await e2eDb.insert(approvals).values({
    id: approvalId,
    orgId: organization.id,
    type: "approve_strategy",
    requestedByAgentId: agent.id,
    status: "pending",
    payload: { issueId: approvalIssueId },
  });
  await e2eDb.insert(automations).values({
    id: automationId,
    orgId: organization.id,
    title: "Semantic card automation",
    assigneeAgentId: agent.id,
    status: "active",
  });

  const entities: SemanticEntities = {
    goalIds,
    issueId,
    issueRef,
    approvalIssueId,
    approvalIssueRef,
    commentId,
    projectId,
    approvalId,
    automationId,
    triggerId,
  };
  return { organization, agent, entities };
}

function toolResult(value: unknown) {
  return JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { result: value },
    _meta: null,
  });
}

function semanticTranscript(
  agentId: string,
  entities: SemanticEntities,
  start = new Date("2026-08-26T08:00:00.000Z"),
) {
  const at = (offset: number) => new Date(start.getTime() + offset * 1_000).toISOString();
  const goalRows = entities.goalIds.map((id, index) => ({
    id,
    title: `Goal ${index + 1}: semantic transcript coverage`,
    lifecycle: "active",
    ownerAgentId: agentId,
    updatedAt: at(index),
  }));
  return [
    { kind: "assistant", ts: at(0), text: "Checking Goal results." },
    { kind: "tool_call", ts: at(1), name: "mcp__rudder-tools__rudder_goal_list", toolUseId: "goal-list", input: { orgId: "current" } },
    { kind: "tool_result", ts: at(2), toolUseId: "goal-list", content: toolResult(goalRows), isError: false },
    { kind: "assistant", ts: at(3), text: "Adding the requested Issue comment." },
    { kind: "tool_call", ts: at(4), name: "mcp__rudder-tools__rudder_issue_comment", toolUseId: "issue-comment", input: { issueId: entities.issueRef } },
    { kind: "tool_result", ts: at(5), toolUseId: "issue-comment", content: toolResult({ id: entities.commentId, issueId: entities.issueRef, body: "Card-ready comment", authorAgentId: agentId }), isError: false },
    { kind: "assistant", ts: at(6), text: "Reading the Project summary." },
    { kind: "tool_call", ts: at(7), name: "mcp__rudder-tools__rudder_project_get", toolUseId: "project-get", input: { projectId: entities.projectId } },
    { kind: "tool_result", ts: at(8), toolUseId: "project-get", content: toolResult({ id: entities.projectId, name: "MCP Cards", status: "in_progress", leadAgentId: agentId }), isError: false },
    { kind: "assistant", ts: at(9), text: "Reading the Approval summary." },
    { kind: "tool_call", ts: at(10), name: "mcp__rudder-tools__rudder_approval_get", toolUseId: "approval-get", input: { approvalId: entities.approvalId } },
    { kind: "tool_result", ts: at(11), toolUseId: "approval-get", content: toolResult({ id: entities.approvalId, type: "approve_strategy", status: "pending", requestedByAgentId: agentId }), isError: false },
    { kind: "assistant", ts: at(12), text: "Rotating the Automation webhook secret." },
    { kind: "tool_call", ts: at(13), name: "mcp__rudder-tools__rudder_automation_triggers_rotate_secret", toolUseId: "automation-secret", input: { triggerId: entities.triggerId } },
    {
      kind: "tool_result",
      ts: at(14),
      toolUseId: "automation-secret",
      content: toolResult({
        trigger: { id: entities.triggerId, automationId: entities.automationId, kind: "webhook", lastRotatedAt: at(14) },
        secretMaterial: { webhookUrl: "https://example.test/hook", webhookSecret: "e2e-secret-must-stay-raw" },
      }),
      isError: false,
    },
    { kind: "assistant", ts: at(15), text: "Checking Issues that need Approval." },
    { kind: "tool_call", ts: at(16), name: "mcp__rudder-tools__rudder_approval_issues", toolUseId: "approval-issues", input: {} },
    { kind: "tool_result", ts: at(17), toolUseId: "approval-issues", content: toolResult([{ id: entities.approvalIssueId, identifier: entities.approvalIssueRef, title: "Review deployment plan", status: "in_review" }]), isError: false },
    { kind: "assistant", ts: at(18), text: "Submitting the Goal result for review." },
    { kind: "tool_call", ts: at(19), name: "mcp__rudder-tools__rudder_goal_result_propose", toolUseId: "goal-proposal", input: { goalId: entities.goalIds[0] } },
    { kind: "tool_result", ts: at(20), toolUseId: "goal-proposal", content: toolResult({ id: "proposal-1", goalId: entities.goalIds[0], status: "ready" }), isError: false },
    { kind: "assistant", ts: at(21), text: "Recording the first blocked-work assistance claim." },
    { kind: "tool_call", ts: at(22), name: "mcp__rudder-tools__rudder_issue_block", toolUseId: "issue-assistance", input: { issueId: entities.issueRef } },
    { kind: "tool_result", ts: at(23), toolUseId: "issue-assistance", content: toolResult({ id: entities.issueId, identifier: entities.issueRef, status: "in_progress", blockAudit: { blocked: false } }), isError: false },
    { kind: "assistant", ts: at(24), text: "Recording the confirmed Issue block." },
    { kind: "tool_call", ts: at(25), name: "mcp__rudder-tools__rudder_issue_block", toolUseId: "issue-blocked", input: { issueId: entities.issueRef } },
    { kind: "tool_result", ts: at(26), toolUseId: "issue-blocked", content: toolResult({ id: entities.issueId, identifier: entities.issueRef, status: "blocked", blockAudit: { blocked: true } }), isError: false },
    { kind: "assistant", ts: at(27), text: "Starting the Automation run." },
    { kind: "tool_call", ts: at(28), name: "mcp__rudder-tools__rudder_automation_run", toolUseId: "automation-run", input: { automationId: entities.automationId } },
    { kind: "tool_result", ts: at(29), toolUseId: "automation-run", content: toolResult({ id: "run-1", automationId: entities.automationId, status: "coalesced" }), isError: false },
    { kind: "assistant", ts: at(30), text: "Reading a failed Automation run." },
    { kind: "tool_call", ts: at(31), name: "mcp__rudder-tools__rudder_automation_run", toolUseId: "automation-run-failed", input: { automationId: entities.automationId } },
    { kind: "tool_result", ts: at(32), toolUseId: "automation-run-failed", content: toolResult({ id: "run-2", automationId: entities.automationId, status: "failed" }), isError: false },
    { kind: "assistant", ts: at(33), text: "Deleting an Automation trigger." },
    { kind: "tool_call", ts: at(34), name: "mcp__rudder-tools__rudder_automation_triggers_delete", toolUseId: "automation-trigger-delete", input: { trigger: entities.triggerId } },
    { kind: "tool_result", ts: at(35), toolUseId: "automation-trigger-delete", content: toolResult({ id: entities.triggerId, deleted: true }), isError: false },
    { kind: "assistant", ts: at(36), text: "Reading one malformed covered result." },
    { kind: "tool_call", ts: at(37), name: "mcp__rudder-tools__rudder_issue_get", toolUseId: "malformed-issue", input: { issueId: `${entities.issueRef}-missing` } },
    { kind: "tool_result", ts: at(38), toolUseId: "malformed-issue", content: "not-json", isError: false },
  ];
}

async function expandSemanticRows(surface: Locator) {
  for (const name of [
    /List goals/i,
    /Add issue comment/i,
    /Get project/i,
    /Get approval/i,
    /Rotate automation trigger secret/i,
  ]) {
    const row = surface.getByRole("button", { name: new RegExp(`Expand tool details: .*${name.source}`, "i") });
    await expect(row).toBeVisible();
    await row.click();
  }
}

async function assertFiveDomainPresenters(surface: Locator) {
  await expect(surface.locator('[data-rudder-semantic-presenter="rudder_goal_list"]')).toBeVisible();
  const firstGoalCard = surface.locator('[data-rudder-semantic-rail="goal"] [data-rudder-semantic-card-surface="true"]').first();
  await expect(firstGoalCard.locator('[data-rudder-semantic-agent="true"]')).toContainText("Semantic Card Agent");
  await expect(firstGoalCard.locator('[data-rudder-semantic-agent="true"]')).toContainText("OpenAI · gpt-5.4 · Codex (local)");
  await expect(firstGoalCard).toHaveCSS("width", "352px");
  await expect(surface.locator('[data-rudder-semantic-presenter="rudder_issue_comment"]')).toContainText("Comment added");
  await expect(surface.locator('[data-rudder-semantic-presenter="rudder_issue_comment"]')).toContainText("Card-ready comment");
  await expect(surface.locator('[data-rudder-semantic-presenter="rudder_issue_comment"] [data-rudder-semantic-agent="true"]')).toContainText("Semantic Card Agent");
  await expect(surface.locator('[data-rudder-semantic-presenter="rudder_project_get"]')).toContainText("MCP Cards");
  await expect(surface.locator('[data-rudder-semantic-presenter="rudder_approval_get"]')).toContainText("pending");
  await expect(surface.locator('[data-rudder-semantic-presenter="rudder_automation_triggers_rotate_secret"]')).toContainText("Webhook secret rotated");
  await expect(surface.locator('[data-rudder-semantic-presenter="rudder_automation_triggers_rotate_secret"]')).toContainText("Aug 26");
  await expect(surface).not.toContainText("e2e-secret-must-stay-raw");
  await expect(surface.getByText("Input", { exact: true })).toHaveCount(0);
  await expect(surface.getByText("Response", { exact: true })).toHaveCount(0);
}

async function expandOutcomeRows(surface: Locator) {
  for (const name of [/Approval issues/i, /Propose goal result/i, /Delete automation trigger/i, /Get issue/i]) {
    await surface.getByRole("button", { name: name }).click();
  }
  for (const row of await surface.getByRole("button", { name: /Run automation/i }).all()) {
    await row.click();
  }
  for (const row of await surface.getByRole("button", { name: /Block issue/i }).all()) {
    await row.click();
  }
}

async function assertOutcomeStates(surface: Locator, routePrefix: string, entities: SemanticEntities) {
  const issueBlockPresenters = surface.locator('[data-rudder-semantic-presenter="rudder_issue_block"]');
  await expect(surface.locator(
    `[data-rudder-semantic-presenter="rudder_approval_issues"] a[href="/${routePrefix}/issues/${entities.approvalIssueRef}"]`,
  )).toBeVisible();
  await expect(surface.locator('[data-rudder-semantic-presenter="rudder_goal_result_propose"]')).toContainText("Proposed / awaiting review");
  await expect(issueBlockPresenters.filter({ hasText: "Assistance claim recorded" })).toBeVisible();
  await expect(issueBlockPresenters.filter({ hasText: "Issue blocked" })).toBeVisible();
  const coalescedRun = surface.locator('[data-rudder-semantic-presenter="rudder_automation_run"]').filter({ hasText: "Automation run coalesced" });
  await expect(coalescedRun).toBeVisible();
  const failedRun = surface.locator('[data-rudder-semantic-presenter="rudder_automation_run"]').filter({ hasText: "Automation run failed" });
  await expect(failedRun.locator(".text-red-700")).toBeVisible();
  await expect(failedRun.locator(".text-emerald-700")).toHaveCount(0);
  const deletedTrigger = surface.locator('[data-rudder-semantic-presenter="rudder_automation_triggers_delete"]');
  await expect(deletedTrigger).toContainText("Trigger deleted");
  await expect(deletedTrigger.locator(`a[href$="/automations/${entities.triggerId}"]`)).toHaveCount(0);
  await expect(deletedTrigger.locator(`a[href="/${routePrefix}/automations/${entities.automationId}"]`)).toBeVisible();
  await expect(surface.locator('[data-rudder-semantic-presenter="rudder_issue_get"]')).toContainText("Result unavailable");
}

test.describe("Built-in Rudder MCP semantic cards", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    const response = await page.request.patch("/api/instance/settings/general", {
      data: { experimentalGoalsEnabled: true },
    });
    expect(response.ok(), await response.text()).toBe(true);
  });

  test("renders all five domains in the real Chat Process with a horizontal incremental rail", async ({ page }) => {
    const { organization, agent, entities } = await seedOrganizationAndAgent(page, "Chat-MCP-Cards");
    const chatId = randomUUID();
    const startedAt = new Date("2026-08-26T08:00:00.000Z");
    await e2eDb.insert(chatConversations).values({
      id: chatId,
      orgId: organization.id,
      title: "Semantic cards Chat Process",
      preferredAgentId: agent.id,
    });
    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: chatId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Semantic cards are ready for review.",
      structuredPayload: { __chatTranscript: semanticTranscript(agent.id, entities, startedAt) },
      replyingAgentId: agent.id,
      chatTurnId: randomUUID(),
      turnVariant: 0,
      createdAt: startedAt,
      updatedAt: new Date(startedAt.getTime() + 15_000),
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      localStorage.setItem("rudder.selectedOrganizationId", orgId);
      localStorage.setItem("rudder.theme", "light");
    }, organization.id);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chatId}`);
    const process = page.getByTestId("chat-transcript-item").last();
    await process.getByRole("button", { name: /Worked for/i }).click();
    await expandSemanticRows(process);
    await expandOutcomeRows(process);
    await assertFiveDomainPresenters(process);
    await assertOutcomeStates(process, organization.urlKey, entities);

    const rail = process.locator('[data-rudder-semantic-rail="goal"]');
    await expect(rail.locator("[data-rudder-semantic-card-link]")).toHaveCount(6);
    await rail.evaluate((element) => { element.scrollLeft = element.scrollWidth; element.dispatchEvent(new Event("scroll")); });
    await expect.poll(() => rail.locator("[data-rudder-semantic-card-link]").count()).toBeGreaterThan(6);
    await rail.evaluate((element) => { element.scrollLeft = 420; element.dispatchEvent(new Event("scroll")); });
    const mountedBeforeCollapse = await rail.locator("[data-rudder-semantic-card-link]").count();
    const scrollBeforeCollapse = await rail.evaluate((element) => element.scrollLeft);
    await process.getByRole("button", { name: /Worked for/i }).click();
    await expect(rail).toBeHidden();
    expect(await rail.locator("[data-rudder-semantic-card-link]").count()).toBe(mountedBeforeCollapse);
    await process.getByRole("button", { name: /Worked for/i }).click();
    await expect(rail).toBeVisible();
    expect(await rail.locator("[data-rudder-semantic-card-link]").count()).toBe(mountedBeforeCollapse);
    expect(await rail.evaluate((element) => element.scrollLeft)).toBeCloseTo(scrollBeforeCollapse, 0);
    await rail.focus();
    const scrollBeforeKeyboard = await rail.evaluate((element) => element.scrollLeft);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => rail.evaluate((element) => element.scrollLeft)).toBeGreaterThan(scrollBeforeKeyboard);
    const firstGoalLink = rail.locator(`a[href="/${organization.urlKey}/goals/${entities.goalIds[0]}"]`);
    await expect(firstGoalLink).toBeVisible();
    const cardSurface = await firstGoalLink.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return { boxShadow: style.boxShadow, transitionProperty: style.transitionProperty };
    });
    expect(cardSurface.boxShadow).not.toBe("none");
    expect(cardSurface.transitionProperty).toContain("transform");
    await expect(process.locator(
      `a[href="/${organization.urlKey}/issues/${entities.issueRef}#comment-${entities.commentId}"]`,
    )).toBeVisible();
    await rail.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/rudder-mcp-semantic-cards-chat-light.png", fullPage: false });

    await firstGoalLink.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/goals/${entities.goalIds[0]}$`));
    await expect(page.getByRole("heading", {
      name: "Goal 1: semantic transcript coverage",
      exact: true,
    })).toBeVisible({ timeout: 15_000 });
    await page.goBack();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => localStorage.setItem("rudder.theme", "dark"));
    await page.reload();
    const mobileProcess = page.getByTestId("chat-transcript-item").last();
    const mobileProcessToggle = mobileProcess.getByRole("button", { name: /Worked for/i });
    await expect(mobileProcessToggle).toBeVisible();
    await mobileProcessToggle.click();
    const mobileGoal = mobileProcess.getByRole("button", { name: /tool details: .*List goals/i });
    await expect(mobileGoal).toBeVisible();
    await expect(mobileGoal).toHaveAttribute("aria-expanded", "false");
    await expect(async () => {
      const currentGoal = mobileProcess.getByRole("button", { name: /tool details: .*List goals/i });
      if (await currentGoal.getAttribute("aria-expanded") !== "true") await currentGoal.click();
      await expect(currentGoal).toHaveAttribute("aria-expanded", "true");
    }).toPass({ timeout: 10_000 });
    await expect(mobileProcess.getByRole("button", { name: /Collapse tool details: .*List goals/i })).toBeVisible();
    await expect(async () => {
      const currentGoal = mobileProcess.getByRole("button", { name: /tool details: .*List goals/i });
      if (await currentGoal.getAttribute("aria-expanded") !== "true") await currentGoal.click();
      const currentRail = mobileProcess.locator('[data-rudder-semantic-rail="goal"]');
      await expect(currentRail).toBeVisible();
      expect(await currentRail.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    }).toPass({ timeout: 10_000 });
    await mobileProcess
      .locator('[data-rudder-semantic-rail="goal"]')
      .screenshot({
        path: "/tmp/rudder-mcp-semantic-cards-chat-dark-mobile.png",
        animations: "disabled",
      });
    const mobileComment = mobileProcess.getByRole("button", { name: /tool details: .*Add issue comment/i });
    if (await mobileComment.getAttribute("aria-expanded") !== "true") await mobileComment.click();
    const mobileReceipt = mobileProcess.locator('[data-rudder-semantic-presenter="rudder_issue_comment"]');
    const titleBox = await mobileReceipt.getByText("Comment added", { exact: true }).boundingBox();
    const agentBox = await mobileReceipt.locator('[data-rudder-semantic-agent="true"]').boundingBox();
    expect(titleBox).not.toBeNull();
    expect(agentBox).not.toBeNull();
    expect(titleBox!.y + titleBox!.height).toBeLessThanOrEqual(agentBox!.y);
    expect(await mobileReceipt.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });

  test("renders the same five-domain presenters in real Run Detail and preserves Raw evidence", async ({ page }) => {
    const { organization, agent, entities } = await seedOrganizationAndAgent(page, "Run-MCP-Cards");
    const runId = randomUUID();
    const startedAt = new Date("2026-08-26T09:00:00.000Z");
    await e2eDb.insert(heartbeatRuns).values({
      id: runId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "scheduled",
      triggerDetail: "Semantic cards acceptance",
      status: "succeeded",
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 20_000),
      createdAt: startedAt,
      updatedAt: new Date(startedAt.getTime() + 20_000),
    });
    const transcript = semanticTranscript(agent.id, entities, startedAt);
    await e2eDb.insert(heartbeatRunEvents).values(transcript.map((entry, index) => ({
      orgId: organization.id,
      runId,
      agentId: agent.id,
      seq: index + 1,
      eventType: "transcript.entry",
      stream: "system",
      level: "info",
      message: "semantic card transcript entry",
      payload: entry,
      createdAt: new Date(startedAt.getTime() + index * 1_000),
    })));

    await page.goto("/");
    await page.evaluate((orgId) => {
      localStorage.setItem("rudder.selectedOrganizationId", orgId);
      localStorage.setItem("rudder.theme", "dark");
    }, organization.id);
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto(`/agents/${agent.id}/runs/${runId}`);
    const detail = page.getByTestId("agent-runs-detail-pane");
    await expect(detail).toBeVisible({ timeout: 15_000 });
    await expandSemanticRows(detail);
    await expandOutcomeRows(detail);
    await assertFiveDomainPresenters(detail);
    await assertOutcomeStates(detail, organization.urlKey, entities);
    const detailRail = detail.locator('[data-rudder-semantic-rail="goal"]');
    await detailRail.evaluate((element) => { element.scrollLeft = element.scrollWidth; element.dispatchEvent(new Event("scroll")); });
    await expect.poll(() => detailRail.locator("[data-rudder-semantic-card-link]").count()).toBeGreaterThan(6);
    await detailRail.evaluate((element) => { element.scrollLeft = 420; element.dispatchEvent(new Event("scroll")); });
    const mountedBeforeRaw = await detailRail.locator("[data-rudder-semantic-card-link]").count();
    const scrollBeforeRaw = await detailRail.evaluate((element) => element.scrollLeft);
    await page.screenshot({ path: "/tmp/rudder-mcp-semantic-cards-run-dark.png", fullPage: true });

    await detail.getByRole("button", { name: "raw" }).click();
    await expect(detail).toContainText("e2e-secret-must-stay-raw");
    await detail.getByRole("button", { name: "nice" }).click();
    await expect(detail).not.toContainText("e2e-secret-must-stay-raw");
    const reopenedRail = detail.locator('[data-rudder-semantic-rail="goal"]');
    await expect(reopenedRail).toBeVisible();
    expect(await reopenedRail.locator("[data-rudder-semantic-card-link]").count()).toBe(mountedBeforeRaw);
    expect(await reopenedRail.evaluate((element) => element.scrollLeft)).toBeCloseTo(scrollBeforeRaw, 0);
  });
});
