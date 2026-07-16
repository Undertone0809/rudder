import { expect, test, type Page } from "@playwright/test";

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
      issuePrefix: `C${Date.now().toString(36).slice(-8)}`.toUpperCase().slice(0, 12),
    },
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

async function createActiveChat(page: Page, organizationId: string, title: string) {
  const chatRes = await page.request.post(`/api/orgs/${organizationId}/chats`, {
    data: {
      title,
      summary: `${title} summary`,
      issueCreationMode: "manual_approval",
      planMode: false,
    },
  });
  expect(chatRes.ok()).toBe(true);
  return chatRes.json();
}

async function openArchivedChatSettings(page: Page, organization: { id: string; issuePrefix: string }) {
  await page.addInitScript((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/organization/settings`, { waitUntil: "commit" });
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await expect(page.getByText("Archived conversations", { exact: true })).toBeVisible({ timeout: 15_000 });
}

test.describe("Organization settings archived chats", () => {
  test("keeps archived chats bounded and deletes an archived chat from the row", async ({ page }) => {
    const organization = await createOrganization(page, `Archived-Chat-Settings-${Date.now()}`);
    const targetChat = await createArchivedChat(page, organization.id, "Target archived cleanup");
    for (let index = 0; index < 8; index += 1) {
      await createArchivedChat(page, organization.id, `Archived backlog ${index + 1}`);
    }

    await openArchivedChatSettings(page, organization);

    const scrollRegion = page.getByTestId("archived-chats-scroll-region");
    await expect(scrollRegion).toBeVisible();
    await expect(scrollRegion).toHaveClass(/scrollbar-auto-hide/);
    await expect.poll(async () => scrollRegion.evaluate((node) => getComputedStyle(node).maxHeight)).not.toBe("none");
    await expect(page.getByText("Showing 9 of 9")).toBeVisible();

    await page.getByPlaceholder("Search archived chats...").fill("Target archived");
    await expect(page.getByText("Showing 1 of 9")).toBeVisible();
    const targetRow = page.getByTestId(`archived-chat-row-${targetChat.id}`);
    await expect(targetRow).toContainText("Target archived cleanup");

    const deleteTrigger = targetRow.getByRole("button", { name: "Delete Target archived cleanup" });
    await deleteTrigger.click();
    await expect(page.getByRole("heading", { name: "Delete archived chat?" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Delete archived chat?" })).toHaveCount(0);
    await expect(deleteTrigger).toBeFocused();

    await deleteTrigger.click();
    await expect(page.getByRole("heading", { name: "Delete archived chat?" })).toBeVisible();
    await page.getByRole("button", { name: "Delete" }).click();

    await expect.poll(async () => (await page.request.get(`/api/chats/${targetChat.id}`)).status()).toBe(404);
    await expect(targetRow).toHaveCount(0);
    await expect(page.getByText("No archived chats match this search.")).toBeVisible();
    await expect(page.getByText("Showing 0 of 8")).toBeVisible();
  });

  test("deletes all archived chats in the viewed organization only", async ({ page }) => {
    const organization = await createOrganization(page, `Bulk-Archived-Chat-${Date.now()}`);
    const otherOrganization = await createOrganization(page, `Other-Archived-Chat-${Date.now()}`);
    const archivedChats = await Promise.all([
      createArchivedChat(page, organization.id, "Bulk archived one"),
      createArchivedChat(page, organization.id, "Bulk archived two"),
      createArchivedChat(page, organization.id, "Bulk archived three"),
    ]);
    const activeChat = await createActiveChat(page, organization.id, "Keep active chat");
    const otherArchivedChat = await createArchivedChat(page, otherOrganization.id, "Keep other organization chat");

    await openArchivedChatSettings(page, organization);
    const deleteAll = page.getByRole("button", { name: "Delete all", exact: true });
    await expect(deleteAll).toBeEnabled();
    await deleteAll.click();

    await expect(page.getByRole("heading", { name: "Delete all archived chats?" })).toBeVisible();
    await expect(page.getByText(/all 3 deletable archived chats/)).toBeVisible();
    await page.getByRole("button", { name: "Delete all", exact: true }).last().click();

    await expect(page.getByText("Deleted 3 archived chats.")).toBeVisible();
    await expect(page.getByText("No archived conversations.")).toBeVisible();
    await expect(deleteAll).toBeDisabled();
    for (const chat of archivedChats) {
      await expect.poll(async () => (await page.request.get(`/api/chats/${chat.id}`)).status()).toBe(404);
    }
    expect((await page.request.get(`/api/chats/${activeChat.id}`)).status()).toBe(200);
    expect((await page.request.get(`/api/chats/${otherArchivedChat.id}`)).status()).toBe(200);
    const activityRes = await page.request.get(
      `/api/orgs/${organization.id}/activity?entityType=organization&entityId=${organization.id}`,
    );
    expect(activityRes.ok()).toBe(true);
    const activity = await activityRes.json();
    expect(activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "chat.archived_bulk_deleted",
        details: expect.objectContaining({ deletedCount: 3, skippedExternalCount: 0 }),
      }),
    ]));
  });

  test("keeps archived chats when bulk deletion fails", async ({ page }) => {
    const organization = await createOrganization(page, `Failed-Bulk-Archived-Chat-${Date.now()}`);
    const archivedChat = await createArchivedChat(page, organization.id, "Keep after failed cleanup");
    await page.route(`/api/orgs/${organization.id}/chats/archived`, async (route) => {
      if (route.request().method() === "DELETE") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Bulk cleanup failed" }) });
        return;
      }
      await route.continue();
    });

    await openArchivedChatSettings(page, organization);
    await page.getByRole("button", { name: "Delete all", exact: true }).click();
    await page.getByRole("button", { name: "Delete all", exact: true }).last().click();

    await expect(page.getByRole("alert")).toContainText("Bulk cleanup failed");
    await expect(page.getByTestId(`archived-chat-row-${archivedChat.id}`)).toBeVisible();
    expect((await page.request.get(`/api/chats/${archivedChat.id}`)).status()).toBe(200);
  });
});
