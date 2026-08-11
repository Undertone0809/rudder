import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { and, eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  activityLog,
  agentWakeupRequests,
  approvals,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issueBlockAuditAttempts,
  issueComments,
  issues,
  requests,
} from "../../packages/db/src/index.ts";
import { createLocalAgentJwt } from "../../server/src/agent-auth-jwt.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function createFixture(page: Page) {
  const orgResponse = await page.request.post("/api/orgs", { data: { name: `Block Audit ${Date.now()}` } });
  expect(orgResponse.ok()).toBe(true);
  const org = await orgResponse.json();
  const agentResponse = await page.request.post(`/api/orgs/${org.id}/agents`, {
    data: {
      name: "Recovery Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.6-luna" },
    },
  });
  expect(agentResponse.ok()).toBe(true);
  const agent = await agentResponse.json();
  const issueResponse = await page.request.post(`/api/orgs/${org.id}/issues`, {
    data: {
      title: "Complete through a recoverable external blocker",
      description: "Exercise the three-Run Block Audit.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agent.id,
    },
  });
  expect(issueResponse.ok()).toBe(true);
  return { org, agent, issue: await issueResponse.json() };
}

async function claimBlock(
  page: Page,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  runId: string,
  finishRun = true,
  comment = "GitHub requires the operator to approve the mobile sudo confirmation before token creation can continue.",
) {
  const [openRequest] = await e2eDb.select().from(requests).where(and(
    eq(requests.issueId, fixture.issue.id),
    eq(requests.status, "open"),
  ));
  const priorAttempts = openRequest
    ? await e2eDb.select().from(issueBlockAuditAttempts)
        .where(eq(issueBlockAuditAttempts.requestId, openRequest.id))
    : [];
  const latestAttempt = priorAttempts.sort((left, right) => right.attemptNumber - left.attemptNumber)[0] ?? null;
  const contextSnapshot = latestAttempt
    ? {
        issueId: fixture.issue.id,
        taskId: fixture.issue.id,
        wakeReason: "issue_passive_followup",
        passiveFollowup: {
          originRunId: latestAttempt.rootRunId,
          previousRunId: latestAttempt.runId,
          attempt: latestAttempt.attemptNumber,
        },
      }
    : { issueId: fixture.issue.id, taskId: fixture.issue.id };
  await e2eDb.insert(heartbeatRuns).values({
    id: runId,
    orgId: fixture.org.id,
    agentId: fixture.agent.id,
    invocationSource: "automation",
    triggerDetail: "system",
    status: "running",
    startedAt: new Date(),
    contextSnapshot,
  });
  await e2eDb.update(issues).set({
    checkoutRunId: runId,
    executionRunId: runId,
    executionLockedAt: new Date(),
  }).where(eq(issues.id, fixture.issue.id));
  const jwt = createLocalAgentJwt(fixture.agent.id, fixture.org.id, "codex_local", runId);
  const response = await page.request.patch(`/api/issues/${fixture.issue.id}`, {
    headers: { Authorization: `Bearer ${jwt}`, "x-rudder-run-id": runId },
    data: {
      status: "blocked",
      comment,
    },
  });
  expect(response.ok()).toBe(true);
  if (finishRun) {
    await e2eDb.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
  }
  return response.json();
}

test("audits three Runs, deduplicates Assistance, and resumes the same assignee", async ({ page }) => {
  await page.goto("/");
  const fixture = await createFixture(page);

  const run1 = randomUUID();
  const first = await claimBlock(page, fixture, run1, false);
  expect(first.status).toBe("in_progress");
  expect(first.blockAudit).toMatchObject({ attempt: 1, requiredAttempts: 3, blocked: false });
  await page.goto(`/issues/${fixture.issue.identifier}`);
  await expect(page.getByTestId("issue-request-attention")).toContainText("In progress · Waiting on you");
  await expect(page.getByTestId("issue-request-attention")).not.toContainText("Attempt");
  await expect(page.getByLabel("Comment composer")).toHaveCount(0);

  const duplicateJwt = createLocalAgentJwt(fixture.agent.id, fixture.org.id, "codex_local", run1);
  const duplicate = await page.request.patch(`/api/issues/${fixture.issue.id}`, {
    headers: { Authorization: `Bearer ${duplicateJwt}`, "x-rudder-run-id": run1 },
    data: { status: "blocked", comment: "GitHub requires the operator to approve the mobile sudo confirmation before token creation can continue." },
  });
  expect(duplicate.ok()).toBe(true);
  expect((await duplicate.json()).blockAudit.attempt).toBe(1);
  const changedSameRun = await page.request.patch(`/api/issues/${fixture.issue.id}`, {
    headers: { Authorization: `Bearer ${duplicateJwt}`, "x-rudder-run-id": run1 },
    data: { status: "blocked", comment: "A different operator action is required." },
  });
  expect(changedSameRun.status()).toBe(422);
  expect(await e2eDb.select().from(issueComments).where(eq(issueComments.issueId, fixture.issue.id))).toHaveLength(1);
  await e2eDb.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run1));

  const second = await claimBlock(page, fixture, randomUUID());
  expect(second.status).toBe("in_progress");
  expect(second.blockAudit.attempt).toBe(2);

  const third = await claimBlock(page, fixture, randomUUID());
  expect(third.status).toBe("blocked");
  expect(third.blockAudit).toMatchObject({ attempt: 3, requiredAttempts: 3, blocked: true });
  await page.goto(`/issues/${fixture.issue.identifier}`);
  const issueRequestPanel = page.getByTestId("issue-request-attention");
  await expect(issueRequestPanel).toContainText("Blocked · Waiting on you");
  await expect(issueRequestPanel).not.toContainText("Attempt");
  await expect(issueRequestPanel.getByRole("button", { name: "Send answer" })).toBeDisabled();

  const requestRows = await e2eDb.select().from(requests).where(and(
    eq(requests.issueId, fixture.issue.id),
    eq(requests.status, "open"),
  ));
  expect(requestRows).toHaveLength(1);
  const attempts = await e2eDb.select().from(issueBlockAuditAttempts)
    .where(eq(issueBlockAuditAttempts.requestId, requestRows[0]!.id));
  expect(attempts.map((attempt) => attempt.attemptNumber).sort()).toEqual([1, 2, 3]);
  expect(new Set(attempts.map((attempt) => attempt.rootRunId))).toEqual(new Set([run1]));
  expect(attempts.map((attempt) => attempt.continuationKind).sort()).toEqual([
    "initial",
    "passive_issue_followup",
    "passive_issue_followup",
  ]);
  const auditEvents = await e2eDb.select().from(heartbeatRunEvents).where(
    eq(heartbeatRunEvents.eventType, "issue.block_audit_attempted"),
  );
  expect(auditEvents.filter((event) => [run1, ...attempts.map((attempt) => attempt.runId)].includes(event.runId)))
    .toHaveLength(3);

  await issueRequestPanel.getByPlaceholder("Answer or describe what changed").fill("GitHub mobile confirmation approved.");
  await page.reload();
  await expect(issueRequestPanel.getByPlaceholder("Answer or describe what changed"))
    .toHaveValue("GitHub mobile confirmation approved.");
  await issueRequestPanel.getByRole("button", { name: "Send answer" }).click();
  await expect(page.getByTestId("issue-request-attention")).toHaveCount(0);
  await expect(page.getByLabel("Comment composer")).toBeVisible();
  const terminalIssueRequest = page.getByTestId(`assistance-request-panel-${requestRows[0]!.id}`);
  await expect(terminalIssueRequest.getByRole("heading", { name: `Response received for ${fixture.issue.identifier}` })).toBeVisible();
  await expect(terminalIssueRequest).not.toContainText("Input needed");
  await expect(terminalIssueRequest).not.toContainText("Attempt");
  await expect(terminalIssueRequest).toContainText("Answered");
  await expect(terminalIssueRequest).toContainText("GitHub mobile confirmation approved.");

  await page.reload();
  await expect(page.getByTestId("issue-request-attention")).toHaveCount(0);
  await expect(page.getByLabel("Comment composer")).toBeVisible();
  await expect(page.getByTestId(`assistance-request-panel-${requestRows[0]!.id}`)).toContainText("Answered");

  await page.goto(`/${fixture.org.urlKey}/messenger/approvals`);
  await expect(page.getByRole("heading", { name: "Requests" })).toBeVisible();
  const card = page.getByTestId(`messenger-assistance-card-${requestRows[0]!.id}`);
  await expect(card).toBeVisible();
  await expect(card.getByText("Answered", { exact: true })).toBeVisible();
  await expect(card).toContainText("GitHub mobile confirmation approved.");
  await expect(card.getByRole("link", { name: "Source: Issue" })).toHaveAttribute(
    "href",
    new RegExp(`/issues/${fixture.issue.id}$`),
  );

  const [resumedIssue] = await e2eDb.select().from(issues).where(eq(issues.id, fixture.issue.id));
  expect(resumedIssue?.status).toBe("in_progress");
  const wakeups = await e2eDb.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.agentId, fixture.agent.id),
    eq(agentWakeupRequests.idempotencyKey, `assistance-request:${requestRows[0]!.id}:resolved`),
  ));
  expect(wakeups).toHaveLength(1);
  const resolutionEvents = await e2eDb.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.runId, run1),
    eq(heartbeatRunEvents.eventType, "request.resolved"),
  ));
  expect(resolutionEvents).toHaveLength(1);
  expect(resolutionEvents[0]?.payload).toMatchObject({
    requestId: requestRows[0]!.id,
    resolution: "answered",
    wakeIntentQueued: true,
  });
});

test("keeps a leading render runway around deep-linked Issue activity", async ({ page }) => {
  await page.goto("/");
  const fixture = await createFixture(page);
  const anchor = Date.now() - 90 * 60_000;
  const commentIds = Array.from({ length: 84 }, () => randomUUID());
  await e2eDb.insert(issueComments).values(commentIds.map((id, index) => {
    const createdAt = new Date(anchor + index * 30_000);
    return {
      id,
      orgId: fixture.org.id,
      issueId: fixture.issue.id,
      authorAgentId: fixture.agent.id,
      body: `Activity note ${index + 1}: retain surrounding context when opening a deep link.`,
      createdAt,
      updatedAt: createdAt,
    };
  }));

  const targetIndex = 72;
  const targetId = commentIds[targetIndex]!;
  await page.setViewportSize({ width: 760, height: 1_000 });
  await page.goto(`/${fixture.org.urlKey}/messenger/issues/${fixture.issue.identifier}#comment-${targetId}`);
  const target = page.locator(`#comment-${targetId}`);
  await expect(target).toBeVisible();
  await page.reload();
  await expect(target).toBeVisible();
  await target.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expect(target).toBeInViewport();
  await expect.poll(() => page.getByTestId("issue-detail-main-scroll").evaluate((element) => Math.max(
    element.scrollTop,
    window.scrollY,
    document.scrollingElement?.scrollTop ?? 0,
  ))).toBeGreaterThan(1_000);

  const runway = await page.evaluate(({ ids, targetCommentId }) => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="issue-detail-main-scroll"]');
    const mounted = Array.from(document.querySelectorAll<HTMLElement>('[data-virtualized-activity-key^="comment:"]'));
    if (!scroller || mounted.length === 0) return null;
    const scrollerTop = Math.max(0, scroller.getBoundingClientRect().top);
    const intersecting = mounted
      .map((element) => ({
        id: element.dataset.virtualizedActivityKey?.slice("comment:".length) ?? "",
        rect: element.getBoundingClientRect(),
      }))
      .filter((item) => item.rect.bottom > scrollerTop)
      .sort((left, right) => left.rect.top - right.rect.top);
    const mountedIndexes = mounted
      .map((element) => ids.indexOf(element.dataset.virtualizedActivityKey?.slice("comment:".length) ?? ""))
      .filter((index) => index >= 0);
    return {
      leadingGap: Math.max(0, (intersecting[0]?.rect.top ?? scrollerTop) - scrollerTop),
      mountedBeforeTarget: mountedIndexes.filter((index) => index < ids.indexOf(targetCommentId)).length,
    };
  }, { ids: commentIds, targetCommentId: targetId });

  await page.screenshot({ path: "/tmp/rudder-issue-timeline-leading-runway.png", fullPage: false });
  expect(runway).not.toBeNull();
  expect(runway!.leadingGap).toBeLessThanOrEqual(120);
  expect(runway!.mountedBeforeTarget).toBeGreaterThanOrEqual(24);
});

test("resets the audit when the blocker materially changes", async ({ page }) => {
  await page.goto("/");
  const fixture = await createFixture(page);

  const first = await claimBlock(page, fixture, randomUUID());
  expect(first.blockAudit.attempt).toBe(1);
  const changed = await claimBlock(
    page,
    fixture,
    randomUUID(),
    true,
    "The GitHub login works, but the repository owner must now grant access to the private organization.",
  );
  expect(changed.blockAudit).toMatchObject({ attempt: 1, blocked: false });

  const requestRows = await e2eDb.select().from(requests).where(eq(requests.issueId, fixture.issue.id));
  const [open] = requestRows.filter((request) => request.status === "open");
  const [superseded] = requestRows.filter((request) => request.status === "superseded");
  expect(open).toBeTruthy();
  expect(superseded).toMatchObject({ supersededByRequestId: open!.id });
  await page.goto(`/issues/${fixture.issue.identifier}`);
  await expect(page.getByTestId("issue-request-attention")).toContainText("In progress · Waiting on you");
  await expect(page.getByTestId("issue-request-attention")).toContainText("repository owner must now grant access");
  await expect(page.getByTestId("issue-request-attention")).not.toContainText("Superseded because");
  const [resetAttempt] = await e2eDb.select().from(issueBlockAuditAttempts)
    .where(eq(issueBlockAuditAttempts.requestId, open!.id));
  expect(resetAttempt).toMatchObject({ attemptNumber: 1, resetReason: "reset_after_blocker_change" });
  const supersessionEvents = await e2eDb.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.runId, resetAttempt!.runId),
    eq(heartbeatRunEvents.eventType, "request.superseded"),
  ));
  expect(supersessionEvents).toHaveLength(1);
  expect(supersessionEvents[0]?.payload).toMatchObject({
    requestId: superseded!.id,
    supersededByRequestId: open!.id,
  });
});

test("redacts blocker text across every durable projection", async ({ page }) => {
  await page.goto("/");
  const fixture = await createFixture(page);
  const secret = "ghp_1234567890abcdefghijklmnop";
  const result = await claimBlock(
    page,
    fixture,
    randomUUID(),
    true,
    `GitHub token=${secret} must be replaced before continuing.`,
  );
  expect(result.comment.body).not.toContain(secret);
  expect(result.blockAudit.request.prompt).not.toContain(secret);

  const durable = {
    requests: await e2eDb.select().from(requests).where(eq(requests.issueId, fixture.issue.id)),
    comments: await e2eDb.select().from(issueComments).where(eq(issueComments.issueId, fixture.issue.id)),
    activity: await e2eDb.select().from(activityLog).where(eq(activityLog.entityId, fixture.issue.id)),
  };
  expect(JSON.stringify(durable)).not.toContain(secret);
  expect(JSON.stringify(durable)).toContain("[REDACTED");
});

test("redacts Approval payloads on unified Request list and detail for Agents", async ({ page }) => {
  await page.goto("/");
  const fixture = await createFixture(page);
  const [approval] = await e2eDb.insert(approvals).values({
    orgId: fixture.org.id,
    type: "agent_runtime",
    requestedByAgentId: fixture.agent.id,
    status: "pending",
    payload: {
      nested: { authorization: "Bearer secret-agent-token" },
      visible: "safe",
      jwtValue: "abcdefgh.ijklmnop.qrstuvwx",
    },
  }).returning();
  const jwt = createLocalAgentJwt(fixture.agent.id, fixture.org.id, "codex_local", randomUUID());
  const headers = { Authorization: `Bearer ${jwt}` };

  const listResponse = await page.request.get(`/api/orgs/${fixture.org.id}/requests`, { headers });
  expect(listResponse.ok()).toBe(true);
  const listed = (await listResponse.json()).find((request: { id: string }) => request.id === approval!.id);
  expect(JSON.stringify(listed)).not.toContain("secret-agent-token");
  expect(listed.payload).toMatchObject({ visible: "safe" });

  const detailResponse = await page.request.get(`/api/requests/${approval!.id}`, { headers });
  expect(detailResponse.ok()).toBe(true);
  expect(JSON.stringify(await detailResponse.json())).not.toContain("secret-agent-token");

  const foreignFixture = await createFixture(page);
  const foreignJwt = createLocalAgentJwt(
    foreignFixture.agent.id,
    foreignFixture.org.id,
    "codex_local",
    randomUUID(),
  );
  const crossOrgResponse = await page.request.get(`/api/orgs/${fixture.org.id}/requests`, {
    headers: { Authorization: `Bearer ${foreignJwt}` },
  });
  expect(crossOrgResponse.status()).toBe(403);
});

test("records one attempt and one comment for concurrent duplicate claims", async ({ page }) => {
  await page.goto("/");
  const fixture = await createFixture(page);
  const runId = randomUUID();
  await e2eDb.insert(heartbeatRuns).values({
    id: runId,
    orgId: fixture.org.id,
    agentId: fixture.agent.id,
    invocationSource: "automation",
    triggerDetail: "system",
    status: "running",
    startedAt: new Date(),
    contextSnapshot: { issueId: fixture.issue.id, taskId: fixture.issue.id },
  });
  await e2eDb.update(issues).set({
    checkoutRunId: runId,
    executionRunId: runId,
    executionLockedAt: new Date(),
  }).where(eq(issues.id, fixture.issue.id));
  const jwt = createLocalAgentJwt(fixture.agent.id, fixture.org.id, "codex_local", runId);
  const options = {
    headers: { Authorization: `Bearer ${jwt}`, "x-rudder-run-id": runId },
    data: {
      status: "blocked",
      comment: "The operator must grant access before work can continue.",
    },
  };
  const responses = await Promise.all([
    page.request.patch(`/api/issues/${fixture.issue.id}`, options),
    page.request.patch(`/api/issues/${fixture.issue.id}`, options),
  ]);
  expect(responses.every((response) => response.ok())).toBe(true);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  expect(bodies.map((body) => body.blockAudit.applied).sort()).toEqual([false, true]);
  expect(await e2eDb.select().from(issueBlockAuditAttempts).where(eq(issueBlockAuditAttempts.issueId, fixture.issue.id)))
    .toHaveLength(1);
  expect(await e2eDb.select().from(issueComments).where(eq(issueComments.issueId, fixture.issue.id)))
    .toHaveLength(1);
});

test("persists comment progress and Assistance supersession together", async ({ page }) => {
  await page.goto("/");
  const fixture = await createFixture(page);
  await claimBlock(page, fixture, randomUUID());
  const [request] = await e2eDb.select().from(requests).where(and(
    eq(requests.issueId, fixture.issue.id),
    eq(requests.status, "open"),
  ));

  const progressResponse = await page.request.patch(`/api/issues/${fixture.issue.id}`, {
    data: { comment: "Recovered through a different browser path and resumed verification." },
  });
  expect(progressResponse.ok()).toBe(true);
  const progress = await progressResponse.json();
  expect(progress.comment.body).toContain("Recovered through a different browser path");
  const [superseded] = await e2eDb.select().from(requests).where(eq(requests.id, request!.id));
  expect(superseded).toMatchObject({ status: "superseded" });
});

test("cannot_help keeps a proven block and does not wake the assignee", async ({ page }) => {
  await page.goto("/");
  const fixture = await createFixture(page);
  await claimBlock(page, fixture, randomUUID());
  await claimBlock(page, fixture, randomUUID());
  await claimBlock(page, fixture, randomUUID());

  const [request] = await e2eDb.select().from(requests).where(and(
    eq(requests.issueId, fixture.issue.id),
    eq(requests.status, "open"),
  ));
  const response = await page.request.post(`/api/requests/${request!.id}/resolve`, {
    data: { resolution: "cannot_help", response: "I do not have access to that GitHub organization." },
  });
  expect(response.ok()).toBe(true);

  const [blockedIssue] = await e2eDb.select().from(issues).where(eq(issues.id, fixture.issue.id));
  expect(blockedIssue).toMatchObject({
    status: "blocked",
    checkoutRunId: null,
    executionRunId: null,
    executionLockedAt: null,
  });
  const wakeups = await e2eDb.select().from(agentWakeupRequests).where(
    eq(agentWakeupRequests.idempotencyKey, `assistance-request:${request!.id}:resolved`),
  );
  expect(wakeups).toHaveLength(0);

  const preThreshold = await createFixture(page);
  await claimBlock(page, preThreshold, randomUUID());
  const [earlyRequest] = await e2eDb.select().from(requests).where(and(
    eq(requests.issueId, preThreshold.issue.id),
    eq(requests.status, "open"),
  ));
  const earlyResponse = await page.request.post(`/api/requests/${earlyRequest!.id}/resolve`, {
    data: { resolution: "cannot_help", response: "No operator intervention is available." },
  });
  expect(earlyResponse.ok()).toBe(true);
  const [activeIssue] = await e2eDb.select().from(issues).where(eq(issues.id, preThreshold.issue.id));
  expect(activeIssue?.status).toBe("in_progress");
  expect(await e2eDb.select().from(agentWakeupRequests).where(
    eq(agentWakeupRequests.idempotencyKey, `assistance-request:${earlyRequest!.id}:resolved`),
  )).toHaveLength(0);
});

test("cancels an Assistance Request without changing or waking the Issue", async ({ page }) => {
  await page.goto("/");
  const fixture = await createFixture(page);
  await claimBlock(page, fixture, randomUUID());
  const [request] = await e2eDb.select().from(requests).where(and(
    eq(requests.issueId, fixture.issue.id),
    eq(requests.status, "open"),
  ));
  const response = await page.request.post(`/api/requests/${request!.id}/cancel`, {
    data: { reason: "This work is no longer needed." },
  });
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ status: "cancelled" });
  const [activeIssue] = await e2eDb.select().from(issues).where(eq(issues.id, fixture.issue.id));
  expect(activeIssue?.status).toBe("in_progress");
  expect(await e2eDb.select().from(agentWakeupRequests).where(
    eq(agentWakeupRequests.idempotencyKey, `assistance-request:${request!.id}:resolved`),
  )).toHaveLength(0);
});

test("reassignment supersedes Assistance and prevents a stale assignee wake", async ({ page }) => {
  await page.goto("/");
  const fixture = await createFixture(page);
  await claimBlock(page, fixture, randomUUID());
  const [request] = await e2eDb.select().from(requests).where(and(
    eq(requests.issueId, fixture.issue.id),
    eq(requests.status, "open"),
  ));
  const replacementResponse = await page.request.post(`/api/orgs/${fixture.org.id}/agents`, {
    data: {
      name: "Replacement Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.6-luna" },
    },
  });
  expect(replacementResponse.ok()).toBe(true);
  const replacement = await replacementResponse.json();
  const reassignResponse = await page.request.patch(`/api/issues/${fixture.issue.id}`, {
    data: { assigneeAgentId: replacement.id },
  });
  expect(reassignResponse.ok()).toBe(true);

  const [superseded] = await e2eDb.select().from(requests).where(eq(requests.id, request!.id));
  expect(superseded?.status).toBe("superseded");
  const staleResolve = await page.request.post(`/api/requests/${request!.id}/resolve`, {
    data: { resolution: "answered", response: "This answer belongs to the previous assignee." },
  });
  expect(staleResolve.status()).toBe(200);
  expect(await staleResolve.json()).toMatchObject({ status: "superseded" });
  expect(await e2eDb.select().from(agentWakeupRequests).where(
    eq(agentWakeupRequests.idempotencyKey, `assistance-request:${request!.id}:resolved`),
  )).toHaveLength(0);
});

test("rejects stale Runs and governed stops without creating Assistance", async ({ page }) => {
  await page.goto("/");
  const fixture = await createFixture(page);
  const staleRunId = randomUUID();
  await e2eDb.insert(heartbeatRuns).values({
    id: staleRunId,
    orgId: fixture.org.id,
    agentId: fixture.agent.id,
    invocationSource: "automation",
    triggerDetail: "system",
    status: "succeeded",
    startedAt: new Date(),
    finishedAt: new Date(),
    contextSnapshot: { issueId: fixture.issue.id, taskId: fixture.issue.id },
  });
  await e2eDb.update(issues).set({ checkoutRunId: staleRunId, executionRunId: staleRunId })
    .where(eq(issues.id, fixture.issue.id));
  const staleJwt = createLocalAgentJwt(fixture.agent.id, fixture.org.id, "codex_local", staleRunId);
  const staleResponse = await page.request.patch(`/api/issues/${fixture.issue.id}`, {
    headers: { Authorization: `Bearer ${staleJwt}`, "x-rudder-run-id": staleRunId },
    data: { status: "blocked", comment: "The operator must act." },
  });
  expect(staleResponse.status()).toBe(422);

  const currentRunId = randomUUID();
  await e2eDb.insert(heartbeatRuns).values({
    id: currentRunId,
    orgId: fixture.org.id,
    agentId: fixture.agent.id,
    invocationSource: "automation",
    triggerDetail: "system",
    status: "running",
    startedAt: new Date(),
    contextSnapshot: { issueId: fixture.issue.id, taskId: fixture.issue.id },
  });
  await e2eDb.update(issues).set({ checkoutRunId: currentRunId, executionRunId: currentRunId })
    .where(eq(issues.id, fixture.issue.id));
  const [approval] = await e2eDb.insert(approvals).values({
    orgId: fixture.org.id,
    type: "budget_increase",
    requestedByAgentId: fixture.agent.id,
    status: "pending",
    payload: { reason: "Budget policy owns this stop" },
  }).returning();
  await e2eDb.insert(issueApprovals).values({
    orgId: fixture.org.id,
    issueId: fixture.issue.id,
    approvalId: approval!.id,
    linkedByAgentId: fixture.agent.id,
  });
  const currentJwt = createLocalAgentJwt(fixture.agent.id, fixture.org.id, "codex_local", currentRunId);
  const governedResponse = await page.request.patch(`/api/issues/${fixture.issue.id}`, {
    headers: { Authorization: `Bearer ${currentJwt}`, "x-rudder-run-id": currentRunId },
    data: { status: "blocked", comment: "Budget approval is pending." },
  });
  expect(governedResponse.status()).toBe(422);

  await e2eDb.update(approvals).set({ status: "rejected" }).where(eq(approvals.id, approval!.id));
  const deniedResponse = await page.request.patch(`/api/issues/${fixture.issue.id}`, {
    headers: { Authorization: `Bearer ${currentJwt}`, "x-rudder-run-id": currentRunId },
    data: { status: "blocked", comment: "The denied Approval still owns this stop." },
  });
  expect(deniedResponse.status()).toBe(422);

  await e2eDb.update(approvals).set({ status: "approved" }).where(eq(approvals.id, approval!.id));
  for (const governedStopClass of ["permission", "authentication", "budget", "cancellation", "runtime_safety"]) {
    await e2eDb.update(heartbeatRuns).set({
      contextSnapshot: {
        issueId: fixture.issue.id,
        taskId: fixture.issue.id,
        governedStopClass,
      },
    }).where(eq(heartbeatRuns.id, currentRunId));
    const policyResponse = await page.request.patch(`/api/issues/${fixture.issue.id}`, {
      headers: { Authorization: `Bearer ${currentJwt}`, "x-rudder-run-id": currentRunId },
      data: { status: "blocked", comment: `${governedStopClass} policy owns this stop.` },
    });
    expect(policyResponse.status()).toBe(422);
  }
  expect(await e2eDb.select().from(requests).where(eq(requests.issueId, fixture.issue.id))).toHaveLength(0);
});
