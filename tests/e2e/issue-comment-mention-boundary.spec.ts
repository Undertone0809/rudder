import { expect, test } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

test("issue comment agent mention keeps following typed text outside the token", async ({ page }) => {
  await page.goto("/");

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Comment-Mention-Boundary-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Griffin",
      role: "ceo",
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Mention boundary regression",
      description: "Typing after an agent mention should not extend the token.",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  const activity = page.getByRole("region", { name: "Activity" });
  await expect(activity).toBeVisible();

  const composer = activity.locator(".rudder-milkdown-content [contenteditable='true']").last();
  await expect(composer).toBeVisible();
  await composer.click();
  await page.keyboard.type("@gri");
  await page.getByTestId(`markdown-mention-option-agent:${agent.id}`).click();
  await page.keyboard.type("我们");

  const token = composer.locator("[data-mention-kind='agent']").filter({ hasText: "Griffin (CEO)" }).first();
  await expect(token).toBeVisible();
  await expect(composer).toContainText("Griffin (CEO) 我们");
  await expect(token).not.toContainText("我们");

  await composer.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
  const copiedMarkdown = await page.evaluate(() => navigator.clipboard.readText());
  expect(copiedMarkdown).toContain("[Griffin (CEO)](agent://");
  expect(copiedMarkdown).toContain(") 我们");
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  const commentButton = activity.getByRole("button", { name: "Comment" }).last();
  await expect(commentButton).toBeEnabled();
  const [commentResponse] = await Promise.all([
    page.waitForResponse((response) =>
      /\/api\/issues\/[^/]+\/comments$/.test(new URL(response.url()).pathname)
      && response.request().method() === "POST",
    ),
    commentButton.click(),
  ]);
  expect(commentResponse.ok()).toBe(true);
  const postedComment = await commentResponse.json() as { id: string; body: string };
  expect(postedComment.body).toContain("[Griffin (CEO)](agent://");
  expect(postedComment.body).toContain("intent=wake");
  expect(postedComment.body).toContain(") 我们");

  await expect.poll(async () => {
    const runsRes = await page.request.get(`/api/orgs/${organization.id}/heartbeat-runs?agentId=${agent.id}&limit=20`);
    expect(runsRes.ok()).toBe(true);
    const runs = await runsRes.json() as Array<{ contextSnapshot?: Record<string, unknown> | null }>;
    return runs.filter((run) =>
      run.contextSnapshot?.wakeReason === "issue_comment_mentioned"
      && run.contextSnapshot?.wakeSource === "comment.mention"
      && run.contextSnapshot?.commentId === postedComment.id
    ).length;
  }, {
    timeout: 15_000,
    intervals: [250, 500, 1_000],
  }).toBeGreaterThan(0);
});

test("issue comment mention recovers when the boundary space is deleted before typing", async ({ page }) => {
  await page.goto("/");

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Comment-Mention-Deleted-Space-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Griffin",
      role: "ceo",
      agentRuntimeType: "process",
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Mention boundary deleted space regression",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  const composer = page.getByRole("region", { name: "Activity" }).locator(".rudder-milkdown-content [contenteditable='true']").last();
  await expect(composer).toBeVisible();
  await composer.click();
  await page.keyboard.type("@gri");
  await page.getByTestId(`markdown-mention-option-agent:${agent.id}`).click();

  await page.keyboard.press("Backspace");
  await page.keyboard.type("我们");

  const token = composer.locator("[data-mention-kind='agent']").filter({ hasText: "Griffin (CEO)" }).first();
  await expect(token).toBeVisible();
  await expect(composer).toContainText("Griffin (CEO) 我们");
  await expect(token).not.toContainText("我们");
});

test("issue comment mention keeps punctuation attached while ending the mention token", async ({ page }) => {
  await page.goto("/");

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Comment-Mention-Punctuation-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Griffin",
      role: "ceo",
      agentRuntimeType: "process",
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Mention punctuation boundary regression",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  const composer = page.getByRole("region", { name: "Activity" }).locator(".rudder-milkdown-content [contenteditable='true']").last();
  await expect(composer).toBeVisible();
  await composer.click();
  await page.keyboard.type("@gri");
  await page.getByTestId(`markdown-mention-option-agent:${agent.id}`).click();
  await page.keyboard.press("Backspace");
  await page.keyboard.type("，");

  const token = composer.locator("[data-mention-kind='agent']").filter({ hasText: "Griffin (CEO)" }).first();
  await expect(token).toBeVisible();
  await expect(composer).toContainText("Griffin (CEO)，");
  await expect(composer).not.toContainText("Griffin (CEO) ，");
  await expect(token).not.toContainText("，");
});

test("issue comment mention plain click keeps editing while command click navigates", async ({ page }) => {
  await page.goto("/");

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Comment-Mention-Click-Boundary-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Griffin",
      role: "ceo",
      agentRuntimeType: "process",
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Mention click boundary regression",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  const issuePath = `/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`;
  await page.goto(issuePath);

  const composer = page.getByRole("region", { name: "Activity" }).locator(".rudder-milkdown-content [contenteditable='true']").last();
  await expect(composer).toBeVisible();
  await composer.click();
  await page.keyboard.type("@gri");
  await page.getByTestId(`markdown-mention-option-agent:${agent.id}`).click();

  const token = composer.locator("[data-mention-kind='agent']").filter({ hasText: "Griffin (CEO)" }).first();
  await expect(token).toBeVisible();
  await token.click();
  await page.keyboard.type("继续输入");

  await expect(page).toHaveURL(new RegExp(`${issuePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expect(composer).toContainText("Griffin (CEO) 继续输入");
  await expect(token).not.toContainText("继续输入");

  await token.click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/agents/[^/?]+(?:/dashboard)?(?:\\?.*)?$`));
  await expect(page.getByText("Griffin").first()).toBeVisible({ timeout: 15_000 });
});

test("issue comment skill mention keeps following typed text outside the token", async ({ page }) => {
  const suffix = Date.now();
  await page.goto("/");

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Comment-Skill-Mention-Boundary-${suffix}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Boundary Engineer",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string };

  const skillName = `Boundary Skill ${suffix}`;
  const skillSlug = `boundary-skill-${suffix}`;
  const skillRes = await page.request.post(`/api/orgs/${organization.id}/skills`, {
    data: {
      name: skillName,
      slug: skillSlug,
      markdown: `---\nname: ${skillName}\ndescription: Skill mention boundary regression.\n---\n\n# Boundary Skill\n`,
    },
  });
  expect(skillRes.ok()).toBe(true);
  const skill = await skillRes.json() as { id: string; key: string; slug: string };
  const skillTarget = `skill://org/${encodeURIComponent(skill.id)}?ref=${encodeURIComponent(skill.slug)}`;

  const syncRes = await page.request.post(`/api/agents/${agent.id}/skills/sync?orgId=${encodeURIComponent(organization.id)}`, {
    data: { desiredSkills: [`org:${skill.key}`] },
  });
  expect(syncRes.ok()).toBe(true);

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Skill mention boundary regression",
      description: "Typing after a skill mention should not extend the token.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agent.id,
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  const activity = page.getByRole("region", { name: "Activity" });
  await expect(activity).toBeVisible();

  const composer = activity.locator(".rudder-milkdown-content [contenteditable='true']").last();
  await expect(composer).toBeVisible();
  await composer.click();
  await page.keyboard.type("$boundary");
  const mentionMenu = page.getByTestId("markdown-mention-menu");
  await expect(mentionMenu).toBeVisible({ timeout: 15_000 });
  const skillOption = mentionMenu
    .locator('[data-testid^="markdown-mention-option-skill:"]')
    .filter({ hasText: skillName })
    .first();
  await expect(skillOption).toContainText(skillName, { timeout: 15_000 });
  await skillOption.dispatchEvent("mousedown");
  await page.keyboard.type("可以这么说");

  const token = composer.locator("[data-skill-token='true']").filter({ hasText: skillSlug }).first();
  await expect(token).toBeVisible();
  await expect(composer).toContainText(`${skillSlug} 可以这么说`);
  await expect(token).not.toContainText("可以这么说");

  await composer.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
  const copiedMarkdown = await page.evaluate(() => navigator.clipboard.readText());
  expect(copiedMarkdown).toContain(`[${skillSlug}](`);
  expect(copiedMarkdown).toContain(skillTarget);
  expect(copiedMarkdown).toContain(" 可以这么说");
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  const commentButton = activity.getByRole("button", { name: "Comment" }).last();
  await expect(commentButton).toBeEnabled();
  const [commentResponse] = await Promise.all([
    page.waitForResponse((response) =>
      /\/api\/issues\/[^/]+\/comments$/.test(new URL(response.url()).pathname)
      && response.request().method() === "POST",
    ),
    commentButton.click(),
  ]);
  expect(commentResponse.ok()).toBe(true);
  const postedComment = await commentResponse.json() as { body: string };
  expect(postedComment.body).toContain(`[${skillSlug}](`);
  expect(postedComment.body).toContain(skillTarget);
  expect(postedComment.body).toContain(" 可以这么说");
});

test("issue comment composer focuses from blank surface clicks", async ({ page }) => {
  await page.goto("/");

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Issue-Comment-Composer-Focus-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
    data: {
      title: "Composer blank surface focus regression",
      status: "todo",
      priority: "medium",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const issue = await issueRes.json() as { id: string; identifier: string | null };

  await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);

  const activity = page.getByRole("region", { name: "Activity" });
  await expect(activity).toBeVisible();
  const composerSurface = activity.locator(".chat-composer").last();
  await expect(composerSurface).toBeVisible();
  const surfaceBox = await composerSurface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  await page.mouse.click(surfaceBox!.x + surfaceBox!.width / 2, surfaceBox!.y + surfaceBox!.height - 24);
  await page.keyboard.type("blank surface focus");

  const composer = activity.locator(".rudder-milkdown-content [contenteditable='true']").last();
  await expect(composer).toContainText("blank surface focus");
});
