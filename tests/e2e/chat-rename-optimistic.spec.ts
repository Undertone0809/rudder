import { expect, test } from "@playwright/test";

test("renames a Messenger chat optimistically before the update request returns", async ({ page }) => {
  await page.goto("/");

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Rename-Optimistic-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Slow rename source",
      issueCreationMode: "manual_approval",
      planMode: false,
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };

  await page.addInitScript((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`, { waitUntil: "commit" });

  const threadRow = page.getByTestId(`messenger-thread-chat-${chat.id}`);
  await expect(threadRow).toContainText("Slow rename source", { timeout: 15_000 });

  let patchBody: unknown = null;
  let releasePatch: (() => void) | null = null;
  const patchStarted = new Promise<void>((resolve) => {
    void page.route(`**/api/chats/${chat.id}`, async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      patchBody = route.request().postDataJSON();
      resolve();
      await new Promise<void>((release) => {
        releasePatch = release;
      });
      await route.continue();
    });
  });

  await threadRow.hover();
  await threadRow.getByRole("button", { name: "Chat actions" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const renameInput = threadRow.locator("input");
  await expect(renameInput).toBeVisible();
  await renameInput.fill("Optimistic rename target");
  await renameInput.press("Enter");

  await patchStarted;
  expect(patchBody).toMatchObject({ title: "Optimistic rename target" });
  await expect(threadRow).toContainText("Optimistic rename target");
  await expect(threadRow).not.toContainText("Slow rename source");

  releasePatch?.();
  await expect.poll(async () => {
    const updated = await (await page.request.get(`/api/chats/${chat.id}`)).json() as { title: string };
    return updated.title;
  }).toBe("Optimistic rename target");
});
