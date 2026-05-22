import { expect, test } from "@playwright/test";

test("keeps an unsent messenger composer draft and attachments when switching primary rail routes", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `Chat-Draft-${Date.now()}`,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/chat`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Keep this unsent draft");
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

  const primaryRail = page.getByTestId("primary-rail");
  await primaryRail.getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/dashboard$`), { timeout: 15_000 });

  await primaryRail.getByRole("link", { name: "Messenger" }).click();
  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/messenger/chat(?:\\?.*)?$`), { timeout: 15_000 });
  await expect(composer).toHaveText("Keep this unsent draft");
  await expect(page.getByTestId("chat-pending-attachment")).toHaveCount(2);
  await expect(page.getByTestId("chat-pending-attachments")).toContainText("draft-note.txt");
  await expect(page.getByTestId("chat-pending-attachments")).toContainText("draft-context.md");
});
