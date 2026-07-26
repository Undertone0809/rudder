import { expect, test } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB } from "./support/e2e-env";

test.describe("Chat Agent selector hierarchy", () => {
  test("switches the draft Agent and restores that Agent's runtime defaults", async ({ page }, testInfo) => {
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
    const reviewer = await createE2EChatAgent(page.request, organization.id, {
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

    const agentSelector = page.getByTestId("chat-agent-selector");
    await expect(agentSelector).toContainText("Builder", { timeout: 15_000 });
    await agentSelector.click();

    const agentMenu = page.getByTestId("chat-agent-menu");
    await expect(agentMenu).toBeVisible();
    await expect(agentMenu).toContainText("Builder");
    await expect(agentMenu).toContainText("Reviewer");
    await expect(page.getByRole("menuitemradio")).toHaveCount(2);
    const builderChoice = page.getByTestId(`chat-agent-option-${builder.id}`).getByRole("menuitemradio");
    const reviewerChoice = page.getByTestId(`chat-agent-option-${reviewer.id}`).getByRole("menuitemradio");
    const runtimeEntry = page.getByTestId("chat-agent-runtime-selector");
    await expect(runtimeEntry).toContainText("gpt-5.4 · High");
    await page.screenshot({
      path: testInfo.outputPath("new-chat-agent-picker.png"),
      fullPage: true,
      animations: "disabled",
    });
    await builderChoice.focus();
    await page.keyboard.press("ArrowDown");
    await expect(runtimeEntry).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(reviewerChoice).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(runtimeEntry).toBeFocused();
    await page.keyboard.press("Home");
    await expect(builderChoice).toBeFocused();
    await page.keyboard.press("End");
    await expect(reviewerChoice).toBeFocused();
    await runtimeEntry.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("chat-model-selector"))
      .toContainText("gpt-5.4");
    await expect(page.getByTestId("chat-effort-selector"))
      .toContainText("High");
    await expect(page.getByTestId("chat-model-selector"))
      .toHaveAttribute("aria-haspopup", "listbox");
    await expect(page.getByTestId("chat-effort-selector"))
      .toHaveAttribute("aria-haspopup", "listbox");
    await page.screenshot({
      path: testInfo.outputPath("new-chat-agent-runtime-panel.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 640, height: 720 });
    if (!await agentMenu.isVisible().catch(() => false)) {
      await agentSelector.click();
    }
    await page.getByTestId("chat-agent-runtime-selector").click();
    const narrowRuntimePanel = page.getByTestId("chat-agent-runtime-panel");
    await expect(narrowRuntimePanel).toBeVisible();
    const narrowRuntimePanelBox = await narrowRuntimePanel.boundingBox();
    expect(narrowRuntimePanelBox).not.toBeNull();
    expect(narrowRuntimePanelBox!.x).toBeGreaterThanOrEqual(0);
    expect(narrowRuntimePanelBox!.x + narrowRuntimePanelBox!.width).toBeLessThanOrEqual(640);
    await page.screenshot({
      path: testInfo.outputPath("new-chat-agent-runtime-panel-narrow.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.getByTestId("chat-model-selector").click();
    await page.getByTestId("chat-model-option-gpt-5.6-luna").click();
    await page.keyboard.press("Escape");
    if (!await agentMenu.isVisible().catch(() => false)) {
      await agentSelector.click();
    }
    await page.getByTestId(`chat-agent-option-${reviewer.id}`).getByRole("menuitemradio").click();
    await expect(agentSelector).toContainText("Reviewer");
    await expect(page.getByTestId("chat-agent-runtime-selector"))
      .toContainText("gpt-5.6-sol · Low");
    await page.getByTestId("chat-agent-runtime-selector").click();
    await expect(page.getByTestId("chat-model-selector"))
      .toHaveAttribute("data-value", "");
    await expect(page.getByTestId("chat-effort-selector"))
      .toHaveAttribute("data-value", "");
  });
});
