import { expect, test } from "@playwright/test";

test("issue comment composer uses the chat-style mention panel without exposing mention URLs", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Comment-Mentions-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
    data: {
      name: "mention-project",
      status: "in_progress",
      color: "#0ea5e9",
    },
  });
  expect(projectRes.ok()).toBe(true);
  const project = await projectRes.json() as { id: string; name: string };

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Dylan",
      role: "pm",
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string; name: string };

  const primaryIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Primary issue for comment mentions",
      description: "The comment composer should handle @ mentions like new chat.",
      status: "todo",
      priority: "medium",
      assigneeUserId: "local-board",
    },
  });
  expect(primaryIssueRes.ok()).toBe(true);
  const primaryIssue = await primaryIssueRes.json() as { id: string; identifier: string | null };

  const relatedIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Related mention target",
      description: "This issue appears in the mention picker with metadata.",
      status: "todo",
      priority: "medium",
      projectId: project.id,
      assigneeAgentId: agent.id,
    },
  });
  expect(relatedIssueRes.ok()).toBe(true);
  const relatedIssue = await relatedIssueRes.json() as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.setViewportSize({ width: 1440, height: 980 });
  await page.goto(`/${organization.issuePrefix}/issues/${primaryIssue.identifier ?? primaryIssue.id}`);

  const composer = page.locator('.rudder-milkdown-scope .ProseMirror[contenteditable="true"]').last();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  await composer.click();
  await page.keyboard.type("@rel");

  const mentionMenu = page.getByTestId("markdown-mention-menu");
  await expect(mentionMenu).toBeVisible();
  await expect(mentionMenu).toContainText("Issues");
  await expect(mentionMenu).toContainText("Related mention target");
  await expect(mentionMenu).toContainText("Todo");
  await expect(mentionMenu).toContainText(project.name);
  await expect(mentionMenu).toContainText(agent.name);

  const composerBox = await composer.boundingBox();
  const menuBox = await mentionMenu.boundingBox();
  expect(composerBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.width).toBeGreaterThan(composerBox!.width - 8);

  await page.getByTestId(`markdown-mention-option-issue:${relatedIssue.id}`).click();
  await page.keyboard.type(" mouse");
  await expect(composer.locator(`a[href^="issue://${relatedIssue.id}"]`).first()).toContainText("Related mention target");
  await expect(composer).toContainText("Related mention target mouse");

  await composer.press("ControlOrMeta+A");
  await page.keyboard.type("before  after");
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("ArrowLeft");
  }
  await page.keyboard.type("@dyl");
  await page.getByTestId(`markdown-mention-option-agent:${agent.id}`).click();
  await page.keyboard.type("next ");

  const agentChipLink = composer.locator(`a[href^="agent://${agent.id}"]`).first();
  await expect(agentChipLink).toBeVisible();
  await expect(agentChipLink).toContainText("Dylan");
  await expect(composer).toContainText(/before Dylan.*next\s+after/);

  await agentChipLink.click();
  await page.waitForTimeout(100);
  await expect(page.locator('[class*="_linkDialogPopoverContent_"]')).toHaveCount(0);
  await expect(page.getByText(new RegExp(`agent://${agent.id}`))).toHaveCount(0);

  const commentOnlyRes = await page.request.post(`/api/issues/${primaryIssue.id}/comments`, {
    data: { body: `[${agent.name}](agent://${agent.id}) can you advise?` },
  });
  expect(commentOnlyRes.ok()).toBe(true);
  const afterCommentOnlyRes = await page.request.get(`/api/issues/${primaryIssue.id}`);
  expect(afterCommentOnlyRes.ok()).toBe(true);
  const afterCommentOnly = await afterCommentOnlyRes.json() as {
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  };
  expect(afterCommentOnly.assigneeAgentId).toBeNull();
  expect(afterCommentOnly.assigneeUserId).toBe("local-board");

  const explicitReassignRes = await page.request.patch(`/api/issues/${primaryIssue.id}`, {
    data: {
      comment: `[${agent.name}](agent://${agent.id}) please own this.`,
      assigneeAgentId: agent.id,
      assigneeUserId: null,
    },
  });
  expect(explicitReassignRes.ok()).toBe(true);
  const afterExplicitReassign = await explicitReassignRes.json() as {
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  };
  expect(afterExplicitReassign.assigneeAgentId).toBe(agent.id);
  expect(afterExplicitReassign.assigneeUserId).toBeNull();
});
