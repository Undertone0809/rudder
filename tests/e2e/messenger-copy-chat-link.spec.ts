import { expect, test } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";

test("copies a Messenger chat link and renders it as a New Chat composer token", async ({ page, baseURL }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Copy-Chat-Link-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  await createE2EChatAgent(page.request, organization.id, { name: "Reference Agent" });

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Reference planning chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };

  if (baseURL) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  }

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const threadRow = page.getByTestId(`messenger-thread-chat-${chat.id}`);
  await expect(threadRow).toBeVisible({ timeout: 15_000 });
  await threadRow.hover();
  await threadRow.getByRole("button", { name: "Chat actions" }).click();
  await page.getByRole("menuitem", { name: "Copy Chat Link" }).click();

  const expectedReference = `[Reference planning chat](chat://${chat.id})`;
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(expectedReference);

  await page.getByRole("link", { name: "New chat" }).click();
  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.click();
  await page.keyboard.press("ControlOrMeta+V");

  const chatToken = composer.locator("[data-mention-kind='chat']").filter({ hasText: "Reference planning chat" });
  await expect(chatToken).toBeVisible({ timeout: 15_000 });
  await expect(composer).toContainText("Reference planning chat");
  await expect(composer).not.toContainText(`chat://${chat.id}`);
});
