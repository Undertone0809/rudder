import { expect, test } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB } from "./support/e2e-env";

for (const startMobile of [false, true]) {
  for (const failFirst of [false, true]) {
    test(`first send survives ${startMobile ? "mobile to desktop" : "desktop to mobile"} resize${failFirst ? " and failed retry" : ""}`, async ({ page }) => {
      const orgResponse = await page.request.post("/api/orgs", { data: { name: `Resize-${Date.now()}` } });
      expect(orgResponse.ok()).toBe(true);
      const org = await orgResponse.json();
      const agent = await createE2EChatAgent(page.request, org.id, { name: "Resize agent", command: E2E_CODEX_STUB });
      await page.addInitScript((id) => localStorage.setItem("rudder.selectedOrganizationId", id), org.id);
      const desktop = { width: 1440, height: 960 };
      const mobile = { width: 390, height: 844 };
      await page.setViewportSize(startMobile ? mobile : desktop);
      await page.goto(`/${org.issuePrefix}/messenger/chat?agentId=${agent.id}`);
      const editor = () => page.locator(".rudder-mdxeditor-content").first();
      await expect(editor()).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let posts = 0;
      await page.route(`**/api/orgs/${org.id}/chats/messages/stream`, async (route) => {
        posts += 1;
        if (posts === 1) {
          await gate;
          if (failFirst) { await route.abort("failed"); return; }
        }
        await route.continue();
      });
      const body = `Keep one first turn across resize ${startMobile}-${failFirst}`;
      try {
        await editor().fill(body);
        await page.locator('input[type="file"]').setInputFiles({ name: "resize-note.txt", mimeType: "text/plain", buffer: Buffer.from("retain this attachment") });
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await expect.poll(() => posts).toBe(1);
        await expect(page.getByTestId("chat-pending-first-turn")).toContainText(body);
        await page.setViewportSize(startMobile ? desktop : mobile);
        await expect(page.getByTestId("chat-pending-first-turn")).toContainText(body);
        await expect(page.getByTestId("chat-pending-first-turn")).toContainText("resize-note.txt");
        await editor().press("Enter");
        await expect(page.getByRole("button", { name: "Sending", exact: true })).toBeDisabled();
        expect(posts).toBe(1);
        release();
        if (failFirst) {
          await expect(editor()).toContainText(body);
          await expect(page.getByTestId("chat-pending-first-turn")).toHaveCount(0);
          await page.getByRole("button", { name: "Send", exact: true }).click();
        }
        await expect(page).toHaveURL(/\/messenger\/chat\/[a-f0-9-]+$/, { timeout: 20_000 });
        const chatId = new URL(page.url()).pathname.split("/").pop();
        await expect(page.getByTestId("chat-main-workspace-card")).toContainText("Streaming reply", { timeout: 25_000 });
        const response = await page.request.get(`/api/chats/${chatId}/messages`);
        expect(response.ok()).toBe(true);
        const messages = await response.json();
        expect(messages.filter((message: { role: string; body: string }) => message.role === "user" && message.body === body)).toHaveLength(1);
        expect(posts).toBe(failFirst ? 2 : 1);
      } finally {
        release();
        await page.unrouteAll({ behavior: "wait" });
      }
    });
  }
}
