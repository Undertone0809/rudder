import { expect, test } from "@playwright/test";

test("keeps an unsent messenger composer draft and attachments when switching primary rail routes", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `Chat-Draft-${Date.now()}`,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const organizationPath = organization.urlKey ?? organization.issuePrefix;

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organizationPath}/messenger/chat`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /Create a file or build a site/ })).toBeVisible();
  await page.locator('input[type="file"]').first().setInputFiles([
    {
      name: "draft-note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("draft attachment"),
    },
    {
      name: "draft-context.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Context"),
    },
  ]);
  await expect(page.getByTestId("chat-pending-attachment")).toHaveCount(2);
  await expect(page.getByTestId("chat-pending-attachments")).toContainText("draft-note.txt");
  await expect(page.getByTestId("chat-pending-attachments")).toContainText("draft-context.md");
  await expect(page.getByRole("button", { name: /Create a file or build a site/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Research and plan next steps/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Get a briefing on recent work/ })).toHaveCount(0);

  await composer.fill("Keep this unsent draft");

  await page
    .getByTestId("primary-rail")
    .getByRole("link", { name: "Organization", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/${organizationPath}/dashboard$`), { timeout: 15_000 });

  await page
    .getByTestId("primary-rail")
    .getByRole("link", { name: "Messenger", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/${organizationPath}/messenger/chat(?:\\?.*)?$`), { timeout: 15_000 });
  await expect(composer).toHaveText("Keep this unsent draft");
  await expect(page.getByTestId("chat-pending-attachment")).toHaveCount(2);
  await expect(page.getByTestId("chat-pending-attachments")).toContainText("draft-note.txt");
  await expect(page.getByTestId("chat-pending-attachments")).toContainText("draft-context.md");
});
