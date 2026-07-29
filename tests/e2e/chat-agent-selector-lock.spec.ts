import { expect, test } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

test.describe("Chat Agent binding", () => {
  test("locks other Agents after conversation start and keeps bound runtime controls available", async ({ page }, testInfo) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Runtime-Control-Chat-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Internal Runtime Agent",
        role: "engineer",
        title: "Engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          modelReasoningEffort: "high",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };
    const otherAgentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Other Runtime Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.6-sol",
          modelReasoningEffort: "medium",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(otherAgentRes.ok()).toBe(true);
    const otherAgent = await otherAgentRes.json() as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem("rudder.theme", "dark");
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${agent.id}`);
    await expect(page.locator("html")).toHaveClass(/dark/);

    const agentSelector = page.getByTestId("chat-agent-selector");
    await expect(agentSelector).toContainText("Internal Runtime Agent", { timeout: 15_000 });

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await composer.fill("Start the runtime-controlled conversation");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(agentSelector).toBeEnabled({ timeout: 15_000 });
    await expect(
      agentSelector.getByLabel("Agent is bound to this chat"),
    ).toHaveCount(0);
    await agentSelector.click();
    const agentMenu = page.getByTestId("chat-agent-menu");
    await expect(agentMenu).toBeVisible();
    await expect(agentMenu).toContainText("Bound to chat");
    await expect(agentMenu).toContainText("Internal Runtime Agent");
    await expect(agentMenu).toContainText("Other Runtime Agent");
    await expect(
      page.getByTestId(`chat-agent-option-${otherAgent.id}`).getByRole("menuitemradio"),
    ).toBeDisabled();
    await page.getByTestId("chat-agent-runtime-selector").click();
    await expect(page.getByTestId("chat-model-selector")).toBeEnabled();
    await expect(page.getByTestId("chat-effort-selector")).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("started-chat-agent-locked-runtime-available.png"),
      fullPage: true,
      animations: "disabled",
    });

    await expect(page.getByRole("button", { name: "Stop streaming" }))
      .toBeVisible({ timeout: 15_000 });
  });
});
