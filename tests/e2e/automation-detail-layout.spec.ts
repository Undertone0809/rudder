import { expect, test, type Page } from "@playwright/test";

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

test.describe("Automation detail layout", () => {
  test("keeps the editor centered and the trigger workspace stacked", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1200 });

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Automation-Layout-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string };

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Onboarding",
        description: "Project used to verify the automation detail layout.",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Automation Layout Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const automationRes = await page.request.post(`/api/orgs/${organization.id}/automations`, {
      data: {
        title: "Every morning summarize onboarding blockers",
        description: "Check onboarding health and report the top blockers.",
        projectId: project.id,
        assigneeAgentId: agent.id,
        priority: "medium",
      },
    });
    expect(automationRes.ok()).toBe(true);
    const automation = await automationRes.json() as { id: string };

    const triggerRes = await page.request.post(`/api/automations/${automation.id}/triggers`, {
      data: {
        kind: "schedule",
        label: "daily-check",
        cronExpression: "0 10 * * *",
        timezone: "Asia/Shanghai",
      },
    });
    expect(triggerRes.ok()).toBe(true);

    await selectOrganization(page, organization.id);
    await page.goto(`/automations/${automation.id}?tab=triggers`);

    const shell = page.getByTestId("automation-detail-shell");
    const mainCard = page.getByTestId("automation-main-card");
    const summaryRow = page.getByTestId("automation-summary-row");
    const addTriggerCard = page.getByTestId("automation-add-trigger-card");
    const triggersList = page.getByTestId("automation-triggers-list");

    await expect(shell).toBeVisible();
    await expect(mainCard).toBeVisible();
    await expect(summaryRow).toBeVisible();
    await expect(addTriggerCard).toBeVisible();
    await expect(triggersList).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Add trigger" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Configured triggers" })).toBeVisible();

    const viewport = page.viewportSize();
    const shellBox = await shell.boundingBox();
    const mainCardBox = await mainCard.boundingBox();
    const addTriggerBox = await addTriggerCard.boundingBox();
    const triggersListBox = await triggersList.boundingBox();

    expect(viewport).not.toBeNull();
    expect(shellBox).not.toBeNull();
    expect(mainCardBox).not.toBeNull();
    expect(addTriggerBox).not.toBeNull();
    expect(triggersListBox).not.toBeNull();

    const shellCenter = shellBox!.x + shellBox!.width / 2;
    const viewportCenter = viewport!.width / 2;
    expect(Math.abs(shellCenter - viewportCenter)).toBeLessThan(40);
    expect(shellBox!.width).toBeLessThan(980);
    expect(Math.abs(mainCardBox!.x - shellBox!.x)).toBeLessThan(4);
    expect(addTriggerBox!.y + addTriggerBox!.height).toBeLessThan(triggersListBox!.y + 8);
    expect(Math.abs(addTriggerBox!.width - shellBox!.width)).toBeLessThan(12);

    await page.screenshot({
      path: testInfo.outputPath("automation-detail-layout.png"),
      fullPage: true,
    });
  });
});
