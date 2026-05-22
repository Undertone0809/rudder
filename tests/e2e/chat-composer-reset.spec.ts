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

test("clears the composer as soon as a chat send starts", async ({ page }) => {
  const organization = await createStreamingOrg(page, `Clr-Chat-${Date.now()}`);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/chat?agentId=${organization.chatAgent.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Clear me on send");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(composer).toHaveText("");
  await expect(page.getByTestId("chat-user-message-bubble").filter({ hasText: "Clear me on send" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply", { timeout: 15_000 });
});
