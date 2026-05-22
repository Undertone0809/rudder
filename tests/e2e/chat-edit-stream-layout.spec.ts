import { expect, test, type Page } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB } from "./support/e2e-env";

async function createStreamingOrg(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Chat Agent",
    command: E2E_CODEX_STUB,
  });
  return { ...organization, chatAgent };
}

test.describe("Chat edit streaming layout", () => {
  test("shows only the replacement branch while an edited message is streaming", async ({ page }) => {
    const organization = await createStreamingOrg(page, `Edt-Chat-${Date.now()}`);

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/chat?agentId=${organization.chatAgent.id}`);

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
