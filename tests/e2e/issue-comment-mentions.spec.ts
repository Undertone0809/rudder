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
      agentRuntimeConfig: {},
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

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.setViewportSize({ width: 1440, height: 980 });
  await page.goto(`/${organization.issuePrefix}/issues/${primaryIssue.identifier ?? primaryIssue.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").last();
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

  await composer.press("ControlOrMeta+A");
  await page.keyboard.type("@dyl");
  await page.getByTestId(`markdown-mention-option-agent:${agent.id}`).click();

  const agentChip = composer.locator("[data-mention-kind='agent']").first();
  await expect(agentChip).toBeVisible();
  await expect(agentChip).toContainText("Dylan");

  await agentChip.click();
  await page.waitForTimeout(100);
  await expect(page.locator('[class*="_linkDialogPopoverContent_"]')).toHaveCount(0);
  await expect(page.getByText(new RegExp(`agent://${agent.id}`))).toHaveCount(0);
});
