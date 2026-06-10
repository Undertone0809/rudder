import { expect, test } from "@playwright/test";

const ORG_NAME = `Issue-Activity-${Date.now()}`;

test.describe("Issue activity", () => {
  test("hides low-signal updates and names assignment changes", async ({ page }) => {
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `${ORG_NAME}-Details` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Builder",
        role: "engineer",
        title: "Build agent",
        agentRuntimeType: "process",
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Activity behavior issue",
        description: "Initial description.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    const assignRes = await page.request.patch(`/api/issues/${issue.id}`, {
      data: { assigneeAgentId: agent.id, assigneeUserId: null },
    });
    expect(assignRes.ok()).toBe(true);

    const statusRes = await page.request.patch(`/api/issues/${issue.id}`, {
      data: { status: "in_progress" },
    });
    expect(statusRes.ok()).toBe(true);

    const descriptionRes = await page.request.patch(`/api/issues/${issue.id}`, {
      data: { description: "Description-only update should not render as activity." },
    });
    expect(descriptionRes.ok()).toBe(true);

    const titleDescriptionRes = await page.request.patch(`/api/issues/${issue.id}`, {
      data: {
        title: "Activity behavior issue renamed",
        description: "Title and description update should not render as activity.",
      },
    });
    expect(titleDescriptionRes.ok()).toBe(true);

    const createDocumentRes = await page.request.put(`/api/issues/${issue.id}/documents/note`, {
      data: { title: "Activity note", format: "markdown", body: "# First revision" },
    });
    expect(createDocumentRes.ok()).toBe(true);
    const createdDocument = await createDocumentRes.json();
    const updateDocumentRes = await page.request.put(`/api/issues/${issue.id}/documents/note`, {
      data: {
        title: "Activity note",
        format: "markdown",
        body: "# Second revision",
        baseRevisionId: createdDocument.latestRevisionId,
      },
    });
    expect(updateDocumentRes.ok()).toBe(true);

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity).toBeVisible();
    await expect(activity.getByText("assigned the issue to Builder", { exact: false })).toBeVisible();
    const statusActivity = activity.getByTestId("issue-activity-row").filter({ hasText: "moved from Todo to In Progress" });
    await expect(statusActivity).toBeVisible();
    await expect(statusActivity.getByTestId("issue-activity-summary")).toHaveClass(/whitespace-nowrap/);
    await expect(statusActivity.locator('[data-slot="issue-status-icon"][data-status="in_progress"]')).toBeVisible();
    await expect(activity.getByText("updated the title", { exact: false })).toHaveCount(0);
    await expect(activity.getByText("updated the description", { exact: false })).toHaveCount(0);
    await expect(activity.getByText("updated a document note", { exact: false })).toHaveCount(0);
  });

  test("names goal updates instead of rendering generic issue updates", async ({ page }) => {
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `${ORG_NAME}-GoalActivity` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const originalGoalRes = await page.request.post(`/api/orgs/${organization.id}/goals`, {
      data: {
        title: "Original activity goal",
        description: "Initial goal for issue activity.",
        level: "organization",
        status: "active",
      },
    });
    expect(originalGoalRes.ok()).toBe(true);
    const originalGoal = await originalGoalRes.json();

    const nextGoalRes = await page.request.post(`/api/orgs/${organization.id}/goals`, {
      data: {
        title: "Specific activity goal",
        description: "Updated goal for issue activity.",
        level: "organization",
        status: "active",
      },
    });
    expect(nextGoalRes.ok()).toBe(true);
    const nextGoal = await nextGoalRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Goal update activity should be specific",
        description: "Activity should say what changed.",
        status: "todo",
        priority: "medium",
        goalId: originalGoal.id,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    const updateGoalRes = await page.request.patch(`/api/issues/${issue.id}`, {
      data: { goalId: nextGoal.id },
    });
    expect(updateGoalRes.ok()).toBe(true);

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity).toBeVisible();
    await expect(activity.getByText("changed the goal", { exact: false })).toBeVisible();
    await expect(activity.getByText("updated the issue", { exact: false })).toHaveCount(0);
  });

  test("shows chat conversations that created or linked an issue", async ({ page }) => {
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: ORG_NAME },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const linkedIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Issue linked from chat",
        description: "Track chat-linked issue activity.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(linkedIssueRes.ok()).toBe(true);
    const linkedIssue = await linkedIssueRes.json();

    const linkedChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Debug thread",
        contextLinks: [{ entityType: "issue", entityId: linkedIssue.id }],
      },
    });
    expect(linkedChatRes.ok()).toBe(true);

    const conversionChatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
      data: { title: "Customer escalation" },
    });
    expect(conversionChatRes.ok()).toBe(true);
    const conversionChat = await conversionChatRes.json();

    const convertedIssueRes = await page.request.post(`/api/chats/${conversionChat.id}/convert-to-issue`, {
      data: {
        proposal: {
          title: "Issue converted from chat",
          description: "Track issue conversion activity.",
          priority: "medium",
        },
      },
    });
    expect(convertedIssueRes.ok()).toBe(true);
    const convertedPayload = await convertedIssueRes.json();
    const convertedIssue = convertedPayload.issue;

    await page.goto(`/issues/${linkedIssue.identifier ?? linkedIssue.id}`);
    await expect(page.getByRole("region", { name: "Activity" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Debug thread" })).toBeVisible();
    await expect(page.getByText("with this issue linked", { exact: false })).toBeVisible();

    await page.goto(`/issues/${convertedIssue.identifier ?? convertedIssue.id}`);
    await expect(page.getByRole("region", { name: "Activity" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Customer escalation" })).toBeVisible();
    await expect(page.getByText("created this issue from", { exact: false })).toBeVisible();
  });

  test("shows linked approvals in the issue activity stream", async ({ page }) => {
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `${ORG_NAME}-Approvals` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Issue with linked approval",
        description: "Track linked approval placement.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    const approvalRes = await page.request.post(`/api/orgs/${organization.id}/approvals`, {
      data: {
        type: "chat_issue_creation",
        payload: {
          proposedIssue: {
            title: "Follow-up from approval",
            description: "Created from a linked approval.",
            priority: "medium",
          },
        },
        issueIds: [issue.id],
      },
    });
    expect(approvalRes.ok()).toBe(true);
    const approval = await approvalRes.json();

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity).toBeVisible();
    await expect(activity.getByText("linked an approval", { exact: false })).toBeVisible();
    await expect(activity.getByRole("link", { name: "an approval" })).toHaveAttribute(
      "href",
      new RegExp(`/messenger/approvals/${approval.id}$`),
    );
    await expect(activity.getByText("Issue proposed from chat")).toHaveCount(0);
    await expect(page.getByText("Linked Approvals")).toHaveCount(0);
  });

  test("orders an existing approval by the later issue link event", async ({ page }) => {
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `${ORG_NAME}-ExistingApprovalLink` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const approvalRes = await page.request.post(`/api/orgs/${organization.id}/approvals`, {
      data: {
        type: "chat_issue_creation",
        payload: {
          proposedIssue: {
            title: "Existing approval linked later",
            description: "This approval exists before its issue link.",
            priority: "medium",
          },
        },
      },
    });
    expect(approvalRes.ok()).toBe(true);
    const approval = await approvalRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Issue linked after approval",
        description: "Track link timestamp ordering.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    const linkRes = await page.request.post(`/api/issues/${issue.id}/approvals`, {
      data: { approvalId: approval.id },
    });
    expect(linkRes.ok()).toBe(true);

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);
    const activity = page.getByRole("region", { name: "Activity" });
    await expect(activity).toBeVisible();
    await expect(activity.getByText("created the issue", { exact: false })).toBeVisible();
    await expect(activity.getByText("linked an approval", { exact: false })).toBeVisible();
    await expect(activity.getByRole("link", { name: "an approval" })).toHaveAttribute(
      "href",
      new RegExp(`/messenger/approvals/${approval.id}$`),
    );

    const createdBox = await activity.getByText("created the issue", { exact: false }).boundingBox();
    const approvalBox = await activity.getByText("linked an approval", { exact: false }).boundingBox();
    expect(createdBox?.y).toBeLessThan(approvalBox?.y ?? 0);
  });
});
