import { expect, test } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB } from "./support/e2e-env";

test("recovers a failed first turn without replacing a newer draft", async ({ page }) => {
  const orgResponse = await page.request.post("/api/orgs", { data: { name: `First-turn-recovery-${Date.now()}` } });
  expect(orgResponse.ok()).toBe(true);
  const org = await orgResponse.json();
  const agent = await createE2EChatAgent(page.request, org.id, { command: E2E_CODEX_STUB });
  await page.addInitScript((id) => localStorage.setItem("rudder.selectedOrganizationId", id), org.id);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`/${org.urlKey}/messenger/chat?agentId=${agent.id}`);
  const editor = () => page.locator(".rudder-mdxeditor-content").first();
  await expect(editor()).toBeVisible({ timeout: 20_000 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let posts = 0;
  await page.route(`**/api/orgs/${org.id}/chats/messages/stream`, async (route) => {
    posts += 1;
    if (posts === 1) { await gate; await route.abort("failed"); return; }
    await route.continue();
  });
  const original = "Recover the original failed turn with its attachment";
  const replacement = "Do not replace this newer draft";
  try {
    await editor().fill(original);
    await page.locator('input[type="file"]').setInputFiles({
      name: "recovered-note.txt", mimeType: "text/plain", buffer: Buffer.from("Keep this file through failure"),
    });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => posts).toBe(1);
    await expect(page.getByTestId("chat-pending-first-turn")).toContainText(original);
    await page.getByRole("link", { name: "New chat", exact: true }).click();
    await editor().fill(replacement);
    release();
    const recoveredLink = page.getByRole("link", { name: "Open recovered draft", exact: true });
    await expect(recoveredLink).toBeVisible();
    await expect(editor()).toContainText(replacement);
    await expect(recoveredLink).toHaveAttribute("href", new RegExp(`/${org.urlKey}/messenger/chat\\?firstTurnRecovery=`));
    await recoveredLink.click();
    await expect(editor()).toContainText(original);
    await expect(page.getByTestId("chat-pending-attachment")).toContainText("recovered-note.txt");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page).toHaveURL(/\/messenger\/chat\/[a-f0-9-]+$/, { timeout: 20_000 });
    const bubble = page.getByTestId("chat-user-message-bubble").filter({ hasText: original });
    await expect(bubble).toHaveCount(1);
    await expect(bubble.getByText("recovered-note.txt", { exact: true }).filter({ visible: true }).first()).toBeVisible();
    const chatsResponse = await page.request.get(`/api/orgs/${org.id}/chats?status=all`);
    expect(chatsResponse.ok()).toBe(true);
    const chats = await chatsResponse.json();
    expect(chats).toHaveLength(1);
    const messagesResponse = await page.request.get(`/api/chats/${chats[0].id}/messages`);
    expect(messagesResponse.ok()).toBe(true);
    const messages = await messagesResponse.json();
    expect(messages.filter((message: { role: string; body: string }) => message.role === "user" && message.body === original)).toHaveLength(1);
    await page.getByRole("link", { name: "New chat", exact: true }).click();
    await expect(editor()).toContainText(replacement);
    expect(posts).toBe(2);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
