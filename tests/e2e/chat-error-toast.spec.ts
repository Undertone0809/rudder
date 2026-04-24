import { expect, test } from "@playwright/test";
import { E2E_CODEX_ERROR_STUB } from "./support/e2e-env";

const ORG_NAME = `Err-Chat-${Date.now()}`;

test.describe("Chat error toasts", () => {
  test("shows the real runtime error instead of a Node stack frame", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: ORG_NAME,
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          command: E2E_CODEX_ERROR_STUB,
        },
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto("/chat");

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("Why did this fail?");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Failed to send message")).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText("Missing optional dependency @openai/codex-darwin-arm64", { exact: false }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("file:///stub/codex.js:100")).toHaveCount(0);
  });
});
