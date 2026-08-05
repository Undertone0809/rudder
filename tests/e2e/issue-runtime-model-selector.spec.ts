import { expect, test } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";

test.describe("Issue runtime model selector", () => {
  test("uses the selected Agent model from the Assignee picker and More menu", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Issue-runtime-selector-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
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
        status: "todo",
        priority: "medium",
        assigneeAgentId: selectedAgent.id,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier?: string | null };

    await page.goto(`/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    const properties = page.getByRole("region", { name: "Issue properties" });
    await expect(properties).toBeVisible();
    await properties.getByRole("button", { name: /Primary runtime Agent/ }).click();
    await expect(properties.getByTestId("issue-runtime-selector")).toHaveCount(1);

    await properties.getByTestId("issue-runtime-selector").click();
    await expect(page.getByTestId("issue-runtime-option-default-model")).toBeVisible();
    const modelOption = page.locator('[data-testid^="issue-runtime-option-model-"]').first();
    await expect(modelOption).toBeVisible();
    const selectedModelLabel = await modelOption.textContent();
    await modelOption.click();
    const assigneePatch = page.waitForResponse((response) =>
      response.url().includes(`/api/issues/${issue.id}`) && response.request().method() === "PATCH",
    );
    await page.getByTestId("issue-runtime-apply").click();
    expect((await assigneePatch).ok()).toBe(true);
    expect(selectedModelLabel?.trim()).toBeTruthy();

    const persistedAfterPickerRes = await page.request.get(`/api/issues/${issue.id}`);
    expect(persistedAfterPickerRes.ok()).toBe(true);
    const persistedAfterPicker = await persistedAfterPickerRes.json() as {
      assigneeAgentRuntimeOverrides: { agentRuntimeConfig?: Record<string, unknown> } | null;
    };
    expect(persistedAfterPicker.assigneeAgentRuntimeOverrides?.agentRuntimeConfig?.model).toBeTruthy();

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "More issue actions" }).click();
    const moreEntry = page.getByTestId("issue-runtime-menu-entry");
    await expect(moreEntry).toBeVisible();
    await moreEntry.getByTestId("issue-runtime-selector").click();
    await expect(page.getByTestId("issue-runtime-option-default-model")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("issue-runtime-selector-more-menu.png"), fullPage: false });

    await page.getByTestId("issue-runtime-option-default-model").click();
    const resetResponse = page.waitForResponse((response) =>
      response.url().includes(`/api/issues/${issue.id}`) && response.request().method() === "PATCH",
    );
    await page.getByTestId("issue-runtime-apply").click();
    expect((await resetResponse).ok()).toBe(true);
    const persistedAfterReset = await (await page.request.get(`/api/issues/${issue.id}`)).json() as {
      assigneeAgentRuntimeOverrides: Record<string, unknown> | null;
    };
    expect(persistedAfterReset.assigneeAgentRuntimeOverrides).toBeNull();

    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await properties.getByRole("button", { name: /Primary runtime Agent/ }).click();
    await expect(properties.getByRole("button", { name: /Replacement runtime Agent/ })).toBeVisible();
    await properties.getByRole("button", { name: /Replacement runtime Agent/ }).click();
    const persistedAfterReassign = await (await page.request.get(`/api/issues/${issue.id}`)).json() as {
      assigneeAgentId: string;
      assigneeAgentRuntimeOverrides: Record<string, unknown> | null;
    };
    expect(persistedAfterReassign.assigneeAgentId).toBe(replacementAgent.id);
    expect(persistedAfterReassign.assigneeAgentRuntimeOverrides).toBeNull();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("issue-runtime-selector-mobile.png"), fullPage: false });
  });
});
