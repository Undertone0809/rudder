import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_HOME = path.resolve(THIS_DIR, ".tmp/rudder-e2e-home");
const E2E_CODEX_STUB = path.join(E2E_HOME, "bin", "codex");

async function createStreamingOrg(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
      defaultChatAgentRuntimeType: "codex_local",
      defaultChatAgentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

test.describe("Chat edit streaming layout", () => {
  test("shows only the replacement branch while an edited message is streaming", async ({ page }) => {
    const organization = await createStreamingOrg(page, `Edt-Chat-${Date.now()}`);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/chat");

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Original edit target");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Streaming reply for chat.", { exact: false })).toBeVisible({ timeout: 15_000 });

    const originalBubble = page.getByTestId("chat-user-message-bubble").filter({ hasText: "Original edit target" }).last();
    await originalBubble.hover();
    await page.getByRole("button", { name: "Edit message in composer" }).last().click();

    await expect(composer).toContainText("Original edit target");
    await composer.fill("Edited edit target");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(
      page.getByTestId("chat-user-message-bubble").filter({ hasText: "Edited edit target" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId("chat-user-message-bubble").filter({ hasText: "Original edit target" }),
    ).toHaveCount(0);
    await expect(page.getByTestId("chat-user-message-bubble")).toHaveCount(1);
  });
});
