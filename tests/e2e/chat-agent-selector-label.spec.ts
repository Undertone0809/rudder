import { expect, test } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB } from "./support/e2e-env";

test.describe("Chat runtime selector naming", () => {
  test("shows the bound runtime without exposing Agent choices", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Explicit-Runtime-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const builder = await createE2EChatAgent(page.request, organization.id, {
      name: "Builder",
      icon: "code",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        modelReasoningEffort: "high",
        command: E2E_CODEX_STUB,
      },
    });
    await createE2EChatAgent(page.request, organization.id, {
      name: "Reviewer",
      icon: "shield",
      agentRuntimeConfig: {
        model: "gpt-5.6-sol",
        modelReasoningEffort: "low",
        command: E2E_CODEX_STUB,
      },
    });

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${builder.id}`);

    const runtimeSelector = page.getByTestId("chat-runtime-selector");
    await expect(runtimeSelector).toContainText("gpt-5.4 · High", { timeout: 15_000 });
    await expect(runtimeSelector).not.toContainText("Builder");
    await runtimeSelector.click();

    const runtimeMenu = page.getByTestId("chat-runtime-menu");
    await expect(runtimeMenu).toBeVisible();
    await expect(runtimeMenu).not.toContainText("Builder");
    await expect(runtimeMenu).not.toContainText("Reviewer");
    await expect(page.getByRole("menuitemradio")).toHaveCount(0);
    await expect(page.getByTestId("chat-model-selector"))
      .toContainText("gpt-5.4");
    await expect(page.getByTestId("chat-effort-selector"))
      .toContainText("High");
    await expect(page.getByTestId("chat-model-selector"))
      .toHaveAttribute("aria-haspopup", "listbox");
    await expect(page.getByTestId("chat-effort-selector"))
      .toHaveAttribute("aria-haspopup", "listbox");
  });
});
