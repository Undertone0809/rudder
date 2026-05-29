import { expect, test } from "@playwright/test";

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
  const postedComment = await commentResponse.json() as { body: string };
  expect(postedComment.body).toContain("[Griffin (CEO)](agent://");
  expect(postedComment.body).toContain(") 我们");
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
