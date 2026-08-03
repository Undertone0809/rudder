import { expect, test } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

test("issue comments require confirmation unless they direct a real Agent mention", async ({ page }) => {
  test.setTimeout(90_000);

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Comment-Send-Confirmation-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Dylan",
      role: "pm",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string; name: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Confirm comments without Agent mentions",
      description: "Ordinary comments should remain possible without implying that an Agent was notified.",
      status: "todo",
      priority: "medium",
      assigneeUserId: "local-board",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };
  const issueRef = issue.identifier ?? issue.id;

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/issues/${issueRef}`);

  const activity = page.getByRole("region", { name: "Activity" });
  await expect(activity).toBeVisible();
  const composer = activity.locator(".rudder-milkdown-content [contenteditable='true']").last();
  const commentButton = activity.getByRole("button", { name: "Comment" }).last();
  await expect(composer).toBeVisible();

  let commentPostCount = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST"
      && new URL(request.url()).pathname === `/api/issues/${issueRef}/comments`
    ) {
      commentPostCount += 1;
    }
  });

  await composer.click();
  await page.keyboard.type("General project note");
  await commentButton.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("您未 @ 任何 Agent，是否确认直接发送评论？");
  expect(commentPostCount).toBe(0);

  await dialog.getByRole("button", { name: "返回并 @ Agent" }).click();
  await expect(dialog).toBeHidden();
  await expect(composer).toContainText("General project note");
  await expect(composer).toBeFocused();
  expect(commentPostCount).toBe(0);

  await composer.press("ControlOrMeta+Enter");
  await expect(dialog).toBeVisible();
  const ordinaryCommentResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/issues/${issueRef}/comments`
  );
  await dialog.getByRole("button", { name: "直接发送" }).click();
  const ordinaryCommentResponse = await ordinaryCommentResponsePromise;
  expect(ordinaryCommentResponse.ok()).toBe(true);
  await expect(dialog).toBeHidden();
  await expect(activity.getByText("General project note", { exact: true })).toBeVisible();
  expect(commentPostCount).toBe(1);

  await composer.click();
  await page.keyboard.type(`@${agent.name} please review this plain text`);
  await commentButton.click();
  await expect(dialog).toBeVisible();
  expect(commentPostCount).toBe(1);
  await dialog.getByRole("button", { name: "返回并 @ Agent" }).click();
  await expect(composer).toBeFocused();

  await composer.fill("");
  await page.keyboard.type("@");
  const directedAgentOption = page.getByTestId(`markdown-mention-option-agent:${agent.id}`);
  await expect(directedAgentOption).toBeVisible({ timeout: 15_000 });
  await directedAgentOption.click();
  await page.keyboard.type(" please review the directed comment");

  const directedCommentResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/issues/${issueRef}/comments`
  );
  await commentButton.click();
  const directedCommentResponse = await directedCommentResponsePromise;
  expect(directedCommentResponse.ok()).toBe(true);
  await expect(dialog).toBeHidden();
  expect(commentPostCount).toBe(2);

  const directedComment = await directedCommentResponse.json() as { id: string; body: string };
  expect(directedComment.body).toContain(`agent://${agent.id}`);
  expect(directedComment.body).toContain("intent=wake");

  await expect.poll(async () => {
    const runsRes = await page.request.get(`/api/orgs/${organization.id}/heartbeat-runs?agentId=${agent.id}&limit=20`);
    expect(runsRes.ok()).toBe(true);
    const runs = await runsRes.json() as Array<{ contextSnapshot?: Record<string, unknown> | null }>;
    return runs.some((run) =>
      run.contextSnapshot?.wakeReason === "issue_comment_mentioned"
      && run.contextSnapshot?.wakeSource === "comment.mention"
      && run.contextSnapshot?.commentId === directedComment.id
    );
  }, {
    timeout: 15_000,
    intervals: [250, 500, 1_000],
  }).toBe(true);

  const reopenAgentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Reopen Agent",
      role: "pm",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(reopenAgentRes.ok()).toBe(true);
  const reopenAgent = await reopenAgentRes.json() as { id: string };

  const agentReopenIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Reopen with an Agent assignee",
      status: "done",
      priority: "medium",
      assigneeAgentId: reopenAgent.id,
    },
  });
  expect(agentReopenIssueRes.ok()).toBe(true);
  const agentReopenIssue = await agentReopenIssueRes.json() as { id: string; identifier: string | null };
  const agentReopenIssueRef = agentReopenIssue.identifier ?? agentReopenIssue.id;

  await page.goto(`/${organization.issuePrefix}/issues/${agentReopenIssueRef}`);
  const agentReopenActivity = page.getByRole("region", { name: "Activity" });
  const agentReopenComposer = agentReopenActivity.locator(".rudder-milkdown-content [contenteditable='true']").last();
  const agentReopenButton = agentReopenActivity.getByRole("button", { name: "Comment" }).last();
  await expect(agentReopenActivity.getByRole("checkbox", { name: "Re-open" })).toBeChecked();
  await agentReopenComposer.click();
  await page.keyboard.type("Please continue this work");
  const agentReopenResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/issues/${agentReopenIssueRef}/comments`
  );
  await agentReopenButton.click();
  const agentReopenResponse = await agentReopenResponsePromise;
  expect(agentReopenResponse.ok()).toBe(true);
  expect(agentReopenResponse.request().postDataJSON()).toMatchObject({ reopen: true });
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const reopenedIssueRes = await page.request.get(`/api/issues/${agentReopenIssue.id}`);
    expect(reopenedIssueRes.ok()).toBe(true);
    return (await reopenedIssueRes.json() as { status: string }).status;
  }).toBe("todo");
  await expect.poll(async () => {
    const runsRes = await page.request.get(`/api/orgs/${organization.id}/heartbeat-runs?agentId=${reopenAgent.id}&limit=20`);
    expect(runsRes.ok()).toBe(true);
    const runs = await runsRes.json() as Array<{ contextSnapshot?: Record<string, unknown> | null }>;
    return runs.some((run) => run.contextSnapshot?.wakeReason === "issue_reopened_via_comment");
  }, {
    timeout: 15_000,
    intervals: [250, 500, 1_000],
  }).toBe(true);

  const userReopenIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Reopen without an Agent assignee",
      status: "done",
      priority: "medium",
      assigneeUserId: "local-board",
    },
  });
  expect(userReopenIssueRes.ok()).toBe(true);
  const userReopenIssue = await userReopenIssueRes.json() as { id: string; identifier: string | null };
  const userReopenIssueRef = userReopenIssue.identifier ?? userReopenIssue.id;

  await page.goto(`/${organization.issuePrefix}/issues/${userReopenIssueRef}`);
  const userReopenActivity = page.getByRole("region", { name: "Activity" });
  const userReopenComposer = userReopenActivity.locator(".rudder-milkdown-content [contenteditable='true']").last();
  const userReopenButton = userReopenActivity.getByRole("button", { name: "Comment" }).last();
  await expect(userReopenActivity.getByRole("checkbox", { name: "Re-open" })).toBeChecked();
  await userReopenComposer.click();
  await page.keyboard.type("This reopen still needs an Agent");
  await userReopenButton.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "返回并 @ Agent" }).click();
  await expect(userReopenComposer).toContainText("This reopen still needs an Agent");
  await expect(userReopenComposer).toBeFocused();
});
