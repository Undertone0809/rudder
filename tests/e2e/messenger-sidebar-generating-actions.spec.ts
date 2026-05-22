import { expect, test, type Page } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

async function createStreamingOrg(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
    },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

async function createStreamingAgent(page: Page, orgId: string, name: string) {
  const agentRes = await page.request.post(`/api/orgs/${orgId}/agents`, {
    data: {
      name,
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  return agentRes.json();
}

function currentChatId(pageUrl: string) {
  const chatId = new URL(pageUrl).pathname.split("/").pop();
  expect(chatId).toBeTruthy();
  return chatId!;
}

test("shows Messenger sidebar chat actions while a reply is generating", async ({ page }) => {
  const organization = await createStreamingOrg(page, `Sidebar-Generating-${Date.now()}`);
  const agent = await createStreamingAgent(page, organization.id, "Sidebar Operator");
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Generating sidebar actions",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json();

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Keep sidebar actions available");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({ timeout: 15_000 });
  const chatId = currentChatId(page.url());
  const threadRow = page.getByTestId(`messenger-thread-chat-${chatId}`);
  const actionButton = threadRow.getByRole("button", { name: "Chat actions" });
  const generatingIcon = threadRow.getByTestId(`messenger-generating-chat-${chatId}`);

  await expect(threadRow).toBeVisible({ timeout: 15_000 });
  await expect(generatingIcon).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => actionButton.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  await expect.poll(() => generatingIcon.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");

  await threadRow.hover();

  await expect.poll(() => actionButton.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await expect.poll(() => generatingIcon.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  await actionButton.click();
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
});
