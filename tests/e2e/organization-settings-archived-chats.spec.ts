import { expect, test, type Page } from "@playwright/test";

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

async function createArchivedChat(page: Page, organizationId: string, title: string) {
  const chatRes = await page.request.post(`/api/orgs/${organizationId}/chats`, {
    data: {
      title,
      summary: `${title} summary`,
      issueCreationMode: "manual_approval",
      planMode: false,
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json();

  const archiveRes = await page.request.patch(`/api/chats/${chat.id}`, {
    data: { status: "archived" },
  });
  expect(archiveRes.ok()).toBe(true);
  return chat;
}

test.describe("Organization settings archived chats", () => {
  test("keeps archived chats bounded and deletes an archived chat from the row", async ({ page }) => {
    const organization = await createOrganization(page, `Archived-Chat-Settings-${Date.now()}`);
    const targetChat = await createArchivedChat(page, organization.id, "Target archived cleanup");
    for (let index = 0; index < 8; index += 1) {
      await createArchivedChat(page, organization.id, `Archived backlog ${index + 1}`);
    }

    await page.addInitScript((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/organization/settings`, { waitUntil: "commit" });
    await expect(page.getByText("Archived conversations", { exact: true })).toBeVisible({ timeout: 15_000 });

    const scrollRegion = page.getByTestId("archived-chats-scroll-region");
    await expect(scrollRegion).toBeVisible();
    await expect(scrollRegion).toHaveClass(/scrollbar-auto-hide/);
    await expect.poll(async () => scrollRegion.evaluate((node) => getComputedStyle(node).maxHeight)).not.toBe("none");
    await expect(page.getByText("Showing 9 of 9")).toBeVisible();

    await page.getByPlaceholder("Search archived chats...").fill("Target archived");
    await expect(page.getByText("Showing 1 of 9")).toBeVisible();
    const targetRow = page.getByTestId(`archived-chat-row-${targetChat.id}`);
    await expect(targetRow).toContainText("Target archived cleanup");

    await targetRow.getByRole("button", { name: "Delete Target archived cleanup" }).click();
    await expect(page.getByRole("heading", { name: "Delete archived chat?" })).toBeVisible();
    await page.getByRole("button", { name: "Delete" }).click();

    await expect.poll(async () => (await page.request.get(`/api/chats/${targetChat.id}`)).status()).toBe(404);
    await expect(targetRow).toHaveCount(0);
    await expect(page.getByText("No archived chats match this search.")).toBeVisible();
    await expect(page.getByText("Showing 0 of 8")).toBeVisible();
  });
});
