import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

async function focusComposerEnd(composer: Locator) {
  await composer.focus();
  await composer.evaluate((editor) => {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

async function appendComposerText(page: Page, composer: Locator, value: string) {
  await focusComposerEnd(composer);
  await page.keyboard.type(value);
}

async function addAgentMention(page: Page, composer: Locator, agent: { id: string; name: string }) {
  await focusComposerEnd(composer);
  await page.keyboard.type(`@${agent.name.split(" ")[1]}`);
  const option = page.getByTestId(`markdown-mention-option-agent:${agent.id}`);
  await expect(option).toBeVisible({ timeout: 15_000 });
  await option.click();
  await focusComposerEnd(composer);
}

async function mentionWakeRunCount(page: Page, organizationId: string, agentId: string) {
  const response = await page.request.get(
    `/api/orgs/${organizationId}/heartbeat-runs?agentId=${agentId}&limit=20`,
  );
  expect(response.ok()).toBe(true);
  const runs = await response.json() as Array<{ contextSnapshot?: Record<string, unknown> | null }>;
  return runs.filter((run) => (
    run.contextSnapshot?.wakeReason === "issue_comment_mentioned"
    && run.contextSnapshot?.wakeSource === "comment.mention"
  )).length;
}

test("issue comment composer previews, cancels, and preserves per-Agent wake intent", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const suffix = Date.now();
  const orgResponse = await page.request.post("/api/orgs", {
    data: { name: `Pending-Agent-Wakes-${suffix}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const organization = await orgResponse.json() as { id: string; issuePrefix: string };

  const createAgent = async (name: string) => {
    const response = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name,
        role: "pm",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { command: E2E_CODEX_STUB },
      },
    });
    expect(response.ok()).toBe(true);
    return response.json() as Promise<{ id: string; name: string }>;
  };
  const firstAgent = await createAgent(`Noah Platform ${suffix}`);
  const secondAgent = await createAgent(`Noah Product ${suffix}`);

  const issueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Preview Agent starts before posting",
      description: "The operator can cancel one Agent wake without deleting the comment mention.",
      status: "todo",
      priority: "medium",
      assigneeUserId: "local-board",
    },
  });
  expect(issueResponse.ok()).toBe(true);
  const issue = await issueResponse.json() as { id: string; identifier: string | null };
  const issueRef = issue.identifier ?? issue.id;
  const otherIssueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Unrelated issue draft",
      description: "Switching issues must not leak Agent wake state.",
      status: "todo",
      priority: "medium",
      assigneeUserId: "local-board",
    },
  });
  expect(otherIssueResponse.ok()).toBe(true);
  const otherIssue = await otherIssueResponse.json() as { id: string; identifier: string | null };
  const otherIssueRef = otherIssue.identifier ?? otherIssue.id;
  const closedIssueResponse = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Closed issue pending Agent starts",
      description: "Pending Agent controls must not overlap the Re-open control.",
      status: "done",
      priority: "medium",
      assigneeUserId: "local-board",
    },
  });
  expect(closedIssueResponse.ok()).toBe(true);
  const closedIssue = await closedIssueResponse.json() as { id: string; identifier: string | null };
  const closedIssueRef = closedIssue.identifier ?? closedIssue.id;

  await page.goto("/");
  await page.evaluate((organizationId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", organizationId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/issues/${issueRef}`);

  const activity = page.getByRole("region", { name: "Activity" });
  const surface = activity.locator("[aria-label='Comment composer']").last();
  const composer = activity
    .getByTestId("issue-comment-composer-editor-scroll")
    .locator("[contenteditable='true']")
    .last();
  const commentButton = activity.getByRole("button", { name: "Comment" }).last();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  await addAgentMention(page, composer, firstAgent);
  await appendComposerText(page, composer, " and ");
  await addAgentMention(page, composer, firstAgent);
  await appendComposerText(page, composer, " with ");
  await addAgentMention(page, composer, secondAgent);
  await appendComposerText(page, composer, " please review this change");

  const wakeStatus = activity.getByTestId("comment-agent-wake-status");
  const wakeSummary = wakeStatus.getByTestId("comment-agent-wake-summary");
  const firstStatus = page.getByTestId(`comment-agent-wake-status-${firstAgent.id}`);
  const secondStatus = page.getByTestId(`comment-agent-wake-status-${secondAgent.id}`);
  await expect(wakeStatus.getByRole("button")).toHaveCount(1);
  await expect(wakeSummary).toContainText("2 agents will start when sent");
  await expect(firstStatus).toHaveCount(0);
  await wakeSummary.click();
  const wakePopover = page.getByTestId("comment-agent-wake-popover");
  await expect(wakePopover).toBeVisible();
  await expect(firstStatus).toHaveAttribute("data-wake-state", "pending");
  await expect(secondStatus).toHaveAttribute("data-wake-state", "pending");
  await expect(composer.locator(`a[href^="agent://${firstAgent.id}"]`)).toHaveCount(2);

  await page.screenshot({ path: testInfo.outputPath("issue-comment-pending-agent-wakes-desktop.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await expect(wakePopover).toBeHidden();
  await wakeSummary.click();
  await expect(wakePopover).toBeVisible();
  await expect(firstStatus).toBeVisible();
  await expect(secondStatus).toBeVisible();
  await expect(firstStatus).toContainText("Noah Platform");
  await expect(secondStatus).toContainText("Noah Product");
  const [surfaceBox, firstBox, secondBox] = await Promise.all([
    surface.boundingBox(),
    firstStatus.boundingBox(),
    secondStatus.boundingBox(),
  ]);
  expect(surfaceBox).not.toBeNull();
  for (const box of [firstBox, secondBox]) {
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(surfaceBox!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(surfaceBox!.x + surfaceBox!.width + 1);
  }
  await page.screenshot({ path: testInfo.outputPath("issue-comment-pending-agent-wakes-narrow.png") });

  await firstStatus.hover();
  await expect.poll(() => firstStatus.evaluate((button) => (
    getComputedStyle(button, "::before").opacity
  ))).toBe("1");
  const firstStatusBox = await firstStatus.boundingBox();
  expect(firstStatusBox).not.toBeNull();
  await page.mouse.move(
    firstStatusBox!.x + firstStatusBox!.width / 2,
    firstStatusBox!.y + firstStatusBox!.height / 2,
  );
  await page.mouse.down();
  await expect.poll(() => firstStatus.evaluate((button) => (
    getComputedStyle(button, "::before").transform
  ))).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
  await page.mouse.move(1, 1);
  await page.mouse.up();
  await firstStatus.focus();
  await expect(firstStatus).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("issue-comment-pending-agent-wakes-focused.png") });
  await page.keyboard.press("Enter");
  await expect(firstStatus).toHaveAttribute("data-wake-state", "skipped");
  await expect(firstStatus).toContainText("reference only");
  await expect(secondStatus).toHaveAttribute("data-wake-state", "pending");
  await page.screenshot({ path: testInfo.outputPath("issue-comment-pending-agent-wakes-cancelled.png") });

  await page.goto(`/${organization.issuePrefix}/issues/${otherIssueRef}`);
  const otherActivity = page.getByRole("region", { name: "Activity" });
  await expect(otherActivity.getByTestId("comment-agent-wake-status")).toHaveCount(0);
  await expect(otherActivity
    .getByTestId("issue-comment-composer-editor-scroll")
    .locator("[contenteditable='true']")
    .last()).toBeEmpty();
  await page.goto(`/${organization.issuePrefix}/issues/${issueRef}`);
  const restoredWakeSummary = activity.getByTestId("comment-agent-wake-summary");
  await expect(restoredWakeSummary).toContainText("1 of 2 agents will start when sent");
  await restoredWakeSummary.click();
  await expect(firstStatus).toHaveAttribute("data-wake-state", "skipped");
  await expect(secondStatus).toHaveAttribute("data-wake-state", "pending");
  await expect(firstStatus).toBeVisible();

  await composer.evaluate((editor, agentId) => {
    const anchor = editor.querySelector(`a[href^="agent://${agentId}"]`);
    if (!anchor) throw new Error(`Missing Agent mention token: ${agentId}`);
    const range = document.createRange();
    range.selectNode(anchor);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (editor as HTMLElement).focus();
  }, secondAgent.id);
  await page.keyboard.press("Backspace");
  await expect(secondStatus).toHaveCount(0);

  await appendComposerText(page, composer, " and ");
  await addAgentMention(page, composer, secondAgent);
  const refreshedWakeSummary = activity.getByTestId("comment-agent-wake-summary");
  await expect(refreshedWakeSummary).toContainText("2 agents will start when sent");
  await refreshedWakeSummary.click();
  await expect(wakePopover).toBeVisible();
  await expect(secondStatus).toHaveAttribute("data-wake-state", "pending");

  await page.setViewportSize({ width: 1440, height: 900 });
  const commentResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/issues/${issueRef}/comments`
  ));
  await commentButton.click();
  const commentResponse = await commentResponsePromise;
  expect(commentResponse.ok()).toBe(true);
  const comment = await commentResponse.json() as { id: string; body: string };
  expect(comment.body.match(new RegExp(`agent://${firstAgent.id}`, "g"))).toHaveLength(2);
  expect(comment.body).not.toContain(`agent://${firstAgent.id}?intent=wake`);
  expect(comment.body).toContain(`agent://${secondAgent.id}?intent=wake`);
  await expect(wakeStatus).toHaveCount(0);

  await expect.poll(
    () => mentionWakeRunCount(page, organization.id, secondAgent.id),
    { timeout: 15_000, intervals: [250, 500, 1_000] },
  ).toBe(1);
  expect(await mentionWakeRunCount(page, organization.id, firstAgent.id)).toBe(0);

  await addAgentMention(page, composer, firstAgent);
  await appendComposerText(page, composer, " and ");
  await addAgentMention(page, composer, secondAgent);
  await appendComposerText(page, composer, " keep this draft after a failed request");
  await page.getByTestId("comment-agent-wake-summary").click();
  await expect(firstStatus).toHaveAttribute("data-wake-state", "pending");
  await firstStatus.click();
  await expect(firstStatus).toHaveAttribute("data-wake-state", "skipped");
  await expect(secondStatus).toHaveAttribute("data-wake-state", "pending");
  await page.route(`**/api/issues/${issueRef}/comments`, async (route) => {
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "test failure" }) });
  }, { times: 1 });
  await commentButton.click();
  await expect(firstStatus).toHaveAttribute("data-wake-state", "skipped");
  await expect(secondStatus).toHaveAttribute("data-wake-state", "pending");
  await expect(composer).toContainText("keep this draft after a failed request");

  const retryResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/issues/${issueRef}/comments`
    && response.status() < 500
  ));
  await commentButton.click();
  expect((await retryResponsePromise).ok()).toBe(true);
  await expect(wakeStatus).toHaveCount(0);

  await page.goto(`/${organization.issuePrefix}/issues/${closedIssueRef}`);
  const closedActivity = page.getByRole("region", { name: "Activity" });
  const closedComposer = closedActivity
    .getByTestId("issue-comment-composer-editor-scroll")
    .locator("[contenteditable='true']")
    .last();
  await expect(closedActivity.getByRole("checkbox", { name: "Re-open" })).toBeChecked();
  await addAgentMention(page, closedComposer, firstAgent);
  await appendComposerText(page, closedComposer, " and ");
  await addAgentMention(page, closedComposer, secondAgent);
  await page.setViewportSize({ width: 390, height: 844 });
  const closedWakeControls = closedActivity.getByTestId("comment-agent-wake-status");
  const reopenControl = closedActivity.getByText("Re-open", { exact: true });
  await expect(closedWakeControls).toBeVisible();
  await expect(reopenControl).toBeVisible();
  const [closedWakeBox, reopenBox] = await Promise.all([
    closedWakeControls.boundingBox(),
    reopenControl.boundingBox(),
  ]);
  expect(closedWakeBox).not.toBeNull();
  expect(reopenBox).not.toBeNull();
  expect(reopenBox!.x).toBeGreaterThanOrEqual(closedWakeBox!.x);
  expect(reopenBox!.x + reopenBox!.width).toBeLessThanOrEqual(closedWakeBox!.x + closedWakeBox!.width + 1);
  expect(reopenBox!.y).toBeGreaterThanOrEqual(closedWakeBox!.y);
  expect(reopenBox!.y + reopenBox!.height).toBeLessThanOrEqual(closedWakeBox!.y + closedWakeBox!.height + 1);
  await page.screenshot({ path: testInfo.outputPath("issue-comment-pending-agent-wakes-closed.png") });
});
