import { expect, test } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";

test.describe("Chat agent selector naming", () => {
  test("defaults to a real agent and remembers the last chat selection", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Explicit-Agent-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    await createE2EChatAgent(page.request, organization.id, { name: "Builder", icon: "code" });
    await createE2EChatAgent(page.request, organization.id, { name: "Reviewer", icon: "shield" });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat`);

    const agentSelector = page.getByTestId("chat-agent-selector");
    await expect(agentSelector).toContainText("Builder", { timeout: 15_000 });
    await expect(agentSelector.getByTestId("chat-agent-selector-icon").locator("svg")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

    await agentSelector.click();
    await expect(page.getByRole("menuitemradio", { name: "No agent selected" })).toHaveCount(0);
    const agentMenuItem = page.getByRole("menuitemradio", { name: /Reviewer/ });
    await expect(agentMenuItem).toBeVisible();
    await agentMenuItem.click();

    await expect(page.getByRole("button", { name: /Reviewer/ })).toBeVisible();
    await expect(agentSelector.getByTestId("chat-agent-selector-icon").locator("svg")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible();
    await composer.fill("Route this through Reviewer");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page).toHaveURL(/\/chat\/[^/]+$/i, { timeout: 15_000 });
    await expect(page.getByRole("button", { name: /Reviewer/ })).toBeVisible();
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply", { timeout: 15_000 });

    await page.goto(`/${organization.issuePrefix}/messenger/chat`);
    await expect(page.getByTestId("chat-agent-selector")).toContainText("Reviewer", { timeout: 15_000 });
  });
});
