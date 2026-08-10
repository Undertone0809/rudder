import { expect, test } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";

test.describe("Issue runtime model selector", () => {
  test("uses the selected Agent model from the hover control beside Assignee", async ({ page }, testInfo) => {
    test.slow();
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Issue-runtime-selector-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    await page.route(`**/api/orgs/${organization.id}/adapters/codex_local/models`, async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: [{
          id: "gpt-5.6-sol",
          label: "gpt-5.6-sol",
          variants: ["low", "medium", "high", "xhigh", "max", "ultra"],
        }],
      });
    });
    const selectedAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Primary runtime Agent",
      model: "gpt-5.4",
    });
    const replacementAgent = await createE2EChatAgent(page.request, organization.id, {
      name: "Replacement runtime Agent",
      model: "gpt-5.4-mini",
    });
    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Choose a model per Issue",
        status: "backlog",
        priority: "medium",
        assigneeAgentId: selectedAgent.id,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier?: string | null };

    await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    const properties = page.getByRole("region", { name: "Issue properties" });
    await expect(properties).toBeVisible();
    const assigneeButton = properties.getByRole("button", {
      name: "Primary runtime Agent",
      exact: true,
    });
    const runtimeSelector = properties.getByTestId("issue-runtime-selector");
    await expect(runtimeSelector).toHaveCount(1);
    await expect(runtimeSelector).toHaveCSS("opacity", "0");
    await assigneeButton.hover();
    await expect(runtimeSelector).toHaveCSS("opacity", "1");

    await runtimeSelector.click();
    await expect(page.getByTestId("issue-runtime-option-default-model")).toBeVisible();
    const modelOption = page.locator('[data-testid^="issue-runtime-option-model-"]').first();
    await expect(modelOption).toBeVisible();
    const selectedModelLabel = await modelOption.textContent();
    await modelOption.click();
    await page.getByTestId("issue-runtime-apply").click();
    expect(selectedModelLabel?.trim()).toBeTruthy();

    await expect.poll(async () => {
      const persistedAfterPickerRes = await page.request.get(`/api/issues/${issue.id}`);
      if (!persistedAfterPickerRes.ok()) return null;
      const persistedAfterPicker = await persistedAfterPickerRes.json() as {
        assigneeAgentRuntimeOverrides: { agentRuntimeConfig?: Record<string, unknown> } | null;
      };
      return persistedAfterPicker.assigneeAgentRuntimeOverrides?.agentRuntimeConfig?.model ?? null;
    }).toBeTruthy();

    await assigneeButton.focus();
    await page.keyboard.press("Tab");
    await expect(runtimeSelector).toBeFocused();
    await expect(runtimeSelector).toHaveCSS("opacity", "1");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("issue-runtime-option-default-model")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "More issue actions" }).click();
    await expect(page.getByTestId("issue-runtime-menu-entry")).toHaveCount(0);
    await expect(page.getByText("Pin Issue", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("issue-runtime-selector-hover.png"), fullPage: false });
    await page.keyboard.press("Escape");

    await assigneeButton.hover();
    await runtimeSelector.click();
    await page.getByTestId("issue-runtime-option-default-model").click();
    await page.getByTestId("issue-runtime-apply").click();
    await expect.poll(async () => {
      const persistedAfterResetRes = await page.request.get(`/api/issues/${issue.id}`);
      if (!persistedAfterResetRes.ok()) return undefined;
      const persistedAfterReset = await persistedAfterResetRes.json() as {
        assigneeAgentRuntimeOverrides: Record<string, unknown> | null;
      };
      return persistedAfterReset.assigneeAgentRuntimeOverrides;
    }).toBeNull();

    await assigneeButton.click();
    const replacementAssigneeButton = page.getByRole("button", {
      name: /^Replacement runtime Agent/,
    });
    await expect(replacementAssigneeButton).toBeVisible();
    await expect(
      page
        .getByTestId("issue-properties-assignee-scroll")
        .getByTestId("issue-runtime-selector"),
    ).toHaveCount(0);
    await replacementAssigneeButton.click();
    await expect.poll(async () => {
      const persistedAfterReassignRes = await page.request.get(`/api/issues/${issue.id}`);
      if (!persistedAfterReassignRes.ok()) return null;
      const persistedAfterReassign = await persistedAfterReassignRes.json() as {
        assigneeAgentId: string;
        assigneeAgentRuntimeOverrides: Record<string, unknown> | null;
      };
      return [persistedAfterReassign.assigneeAgentId, persistedAfterReassign.assigneeAgentRuntimeOverrides];
    }).toEqual([replacementAgent.id, null]);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Properties", exact: true }).click();
    const mobileRuntimeSelector = page.locator('[data-testid="issue-runtime-selector"]:visible');
    await expect(mobileRuntimeSelector).toHaveCount(1);
    await expect(mobileRuntimeSelector).toHaveCSS("opacity", "1");
    await page.screenshot({ path: testInfo.outputPath("issue-runtime-selector-mobile.png"), fullPage: false });
  });
});
