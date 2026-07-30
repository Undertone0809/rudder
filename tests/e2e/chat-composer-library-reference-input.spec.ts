import { expect, test, type Page } from "@playwright/test";

import { createE2EChatAgent } from "./support/chat-agent";

async function selectOrganization(page: Page, organizationId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrganizationId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrganizationId);
  }, organizationId);
}

test("keeps the composer editable after inserting a Library file reference", async ({ page }, testInfo) => {
  const suffix = Date.now();
  const organizationResponse = await page.request.post("/api/orgs", {
    data: { name: `Library-Reference-Input-${suffix}` },
  });
  expect(organizationResponse.ok(), await organizationResponse.text()).toBe(true);
  const organization = await organizationResponse.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: `Library Reference Agent ${suffix}`,
  }) as { id: string };

  const fileName = `reference-${suffix}.md`;
  const filePath = `projects/input-regression/${fileName}`;
  const fileResponse = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath,
      content: "# Input regression\n",
    },
  });
  expect(fileResponse.ok(), await fileResponse.text()).toBe(true);

  await selectOrganization(page, organization.id);
  await page.goto(
    `/${organization.issuePrefix}/messenger/chat?agentId=${encodeURIComponent(agent.id)}`,
  );

  const composer = page.locator(".chat-composer .rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.click();

  await page.keyboard.type(`@${fileName}`);
  await expect(
    page.getByTestId(`markdown-mention-option-library-file:${filePath}`),
  ).toContainText(fileName, { timeout: 15_000 });
  await page.keyboard.press("Tab");

  const token = composer
    .locator("[data-mention-kind='library_entry'], [data-mention-kind='library_file']")
    .filter({ hasText: fileName });
  await expect(token).toBeVisible();

  for (const key of [
    "a",
    "f",
    "t",
    "e",
    "r",
    "-",
    "r",
    "e",
    "f",
    "e",
    "r",
    "e",
    "n",
    "c",
    "e",
    "Space",
  ]) {
    await composer.press(key);
  }
  await page.keyboard.insertText("继续输入正常内容");

  await expect(composer).toContainText("after-reference 继续输入正常内容");
  await expect(token).not.toContainText("继续输入正常内容");
  await expect(token).not.toContainText("after-reference");
  await expect(composer).toBeFocused();

  await page.screenshot({
    path: testInfo.outputPath("chat-composer-library-reference-input.png"),
    fullPage: true,
  });
});
