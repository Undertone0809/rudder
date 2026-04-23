import { test, expect, type Page } from "@playwright/test";

const SKIP_LLM = process.env.RUDDER_E2E_SKIP_LLM !== "false";

function onboardingHeading(page: Page, text: string) {
  return page.locator("h3", { hasText: text });
}

async function expectOnboardingStep(page: Page, text: string) {
  await expect(onboardingHeading(page, text)).toBeVisible({ timeout: 15_000 });
}

test.describe("Onboarding wizard", () => {
  test("fresh onboarding stays sequential and defaults Codex to gpt-5.4", async ({
    page,
  }) => {
    const initialOrganizationName = `E2E-Fresh-${Date.now()}`;
    const updatedOrganizationName = `${initialOrganizationName}-Updated`;
    const updatedAgentName = "Founding CEO";
    const taskTitle = "E2E fresh onboarding task";

    await page.goto("/onboarding");

    await expectOnboardingStep(page, "Name your organization");

    await expect(
      page.locator('[data-testid="onboarding-step-tab-4"]')
    ).toBeDisabled();

    await page
      .locator('input[placeholder="Acme Corp"]')
      .fill(initialOrganizationName);

    await page.getByRole("button", { name: "Next" }).click();

    await expectOnboardingStep(page, "Create your first agent");
    await page.getByRole("button", { name: "Back" }).click();
    await expectOnboardingStep(page, "Name your organization");
    await page
      .locator('input[placeholder="Acme Corp"]')
      .fill(updatedOrganizationName);
    await page.getByRole("button", { name: "Next" }).click();
    await expectOnboardingStep(page, "Create your first agent");

    await expect(
      page.locator('[data-testid="onboarding-step-tab-3"]')
    ).toBeDisabled();

    const onboardingNameInput = page.locator('input[placeholder="Agent name"]');
    await expect(page.getByText("Agent name", { exact: true })).toBeVisible();
    await expect(page.getByText("Agent name (optional)")).toHaveCount(0);
    await expect(onboardingNameInput).toHaveValue(/\S+/, { timeout: 15_000 });
    await page.getByRole("button", { name: "Codex" }).click();
    await expect(
      page.getByRole("button", { name: "gpt-5.4" })
    ).toBeVisible();

    await page.getByRole("button", { name: "Next" }).click();

    await expectOnboardingStep(page, "Give it something to do");
    await page.getByRole("button", { name: "Back" }).click();
    await expectOnboardingStep(page, "Create your first agent");
    await onboardingNameInput.fill(updatedAgentName);
    await page.getByRole("button", { name: "Next" }).click();
    await expectOnboardingStep(page, "Give it something to do");

    await expect(
      page.locator('[data-testid="onboarding-step-tab-4"]')
    ).toBeDisabled();

    const taskTitleInput = page.locator(
      'input[placeholder="e.g. Research competitor pricing"]'
    );
    await taskTitleInput.clear();
    await taskTitleInput.fill(taskTitle);

    await page.getByRole("button", { name: "Next" }).click();

    await expectOnboardingStep(page, "Ready to launch");
    await page.locator('[data-testid="onboarding-step-tab-2"]').click();
    await expectOnboardingStep(page, "Create your first agent");
    await page.locator('[data-testid="onboarding-step-tab-4"]').click();
    await expectOnboardingStep(page, "Ready to launch");
    await expect(
      page.locator('[data-testid="onboarding-launch-summary-organization"]')
    ).toContainText(updatedOrganizationName);
    await expect(
      page.locator('[data-testid="onboarding-launch-summary-project"]')
    ).toContainText("onboarding");
    await expect(
      page.locator('[data-testid="onboarding-launch-summary-task"]')
    ).toContainText(taskTitle);

    await page.getByRole("button", { name: "Create & Open Issue" }).click();

    await expect(page).toHaveURL(/\/issues\//, { timeout: 10_000 });

    const baseUrl = page.url().split("/").slice(0, 3).join("/");

    const organizationsRes = await page.request.get(`${baseUrl}/api/orgs`);
    expect(organizationsRes.ok()).toBe(true);
    const organizations = await organizationsRes.json();
    expect(
      organizations.some((org: { name: string }) => org.name === initialOrganizationName)
    ).toBe(false);
    const organization = organizations.find(
      (org: { name: string }) => org.name === updatedOrganizationName
    );
    expect(organization).toBeTruthy();
    expect(organization.defaultChatAgentRuntimeType).toBe("codex_local");
    expect(organization.defaultChatAgentRuntimeConfig?.model).toBe("gpt-5.4");

    const agentsRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/agents`
    );
    expect(agentsRes.ok()).toBe(true);
    const agents = await agentsRes.json();
    expect(agents).toHaveLength(1);
    const ceoAgent = agents.find(
      (agent: { name: string }) => agent.name === updatedAgentName
    );
    expect(ceoAgent).toBeTruthy();
    expect(ceoAgent.agentRuntimeType).toBe("codex_local");
    expect(ceoAgent.agentRuntimeConfig.model).toBe("gpt-5.4");

    const issuesRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/issues`
    );
    expect(issuesRes.ok()).toBe(true);
    const issues = await issuesRes.json();
    const task = issues.find(
      (issue: { title: string }) => issue.title === taskTitle
    );
    expect(task).toBeTruthy();
    expect(task.assigneeAgentId).toBe(ceoAgent.id);
    const projectsRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/projects`
    );
    expect(projectsRes.ok()).toBe(true);
    const projects = await projectsRes.json();
    const onboardingProjects = projects.filter(
      (project: { name: string; archivedAt?: string | null }) =>
        project.name === "onboarding" && !project.archivedAt
    );
    expect(onboardingProjects).toHaveLength(1);
    expect(task.projectId).toBe(onboardingProjects[0].id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat`, {
      waitUntil: "commit",
    });
    await expect(page.locator(".chat-composer")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".chat-warning")).toHaveCount(0);

    if (!SKIP_LLM) {
      await expect(async () => {
        const res = await page.request.get(`${baseUrl}/api/issues/${task.id}`);
        const issue = await res.json();
        expect(["in_progress", "done"]).toContain(issue.status);
      }).toPass({ timeout: 120_000, intervals: [5_000] });
    }
  });

  test("existing organization onboarding starts at agent and runtime test stays valid", async ({
    page,
  }) => {
    const organizationName = `E2E-Existing-${Date.now()}`;
    const taskTitle = "E2E existing organization task";

    const createRes = await page.request.post("/api/orgs", {
      data: { name: organizationName },
    });
    expect(createRes.ok()).toBe(true);
    const organization = await createRes.json();

    await page.goto(`/${organization.issuePrefix}/dashboard`);

    await page.getByRole("button", { name: "Create one here" }).click();

    await expectOnboardingStep(page, "Create your first agent");
    const onboardingNameInput = page.locator('input[placeholder="Agent name"]');
    await expect(page.getByText("Agent name", { exact: true })).toBeVisible();
    await expect(page.getByText("Agent name (optional)")).toHaveCount(0);
    await expect(onboardingNameInput).toHaveValue(/\S+/, { timeout: 15_000 });

    await expect(
      page.locator('[data-testid="onboarding-step-tab-4"]')
    ).toBeDisabled();

    await page.getByRole("button", { name: "Codex" }).click();
    await expect(
      page.getByRole("button", { name: "gpt-5.4" })
    ).toBeVisible();

    await page.getByRole("button", { name: "Test now" }).click();
    await expect(
      page.getByText("Command is executable: codex")
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText("Complete organization setup before testing the runtime.")
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Next" }).click();
    await expectOnboardingStep(page, "Give it something to do");

    const taskTitleInput = page.locator(
      'input[placeholder="e.g. Research competitor pricing"]'
    );
    await taskTitleInput.clear();
    await taskTitleInput.fill(taskTitle);

    await page.getByRole("button", { name: "Next" }).click();

    await expectOnboardingStep(page, "Ready to launch");
    await expect(
      page.locator('[data-testid="onboarding-launch-summary-organization"]')
    ).toContainText(organizationName);
    await expect(
      page.locator('[data-testid="onboarding-launch-summary-project"]')
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Back" }).click();
    await expectOnboardingStep(page, "Give it something to do");
  });

  test("new organization drafts are rolled back when onboarding closes before launch", async ({
    page,
  }) => {
    const organizationName = `E2E-Draft-Close-${Date.now()}`;

    await page.goto("/onboarding");
    await expectOnboardingStep(page, "Name your organization");

    await page.locator('input[placeholder="Acme Corp"]').fill(organizationName);
    await page.getByRole("button", { name: "Next" }).click();
    await expectOnboardingStep(page, "Create your first agent");

    await page.getByRole("button", { name: "Close" }).first().click();
    await expect(page.getByRole("button", { name: "Start Onboarding" })).toBeVisible({
      timeout: 15_000,
    });

    await expect
      .poll(async () => {
        const organizationsRes = await page.request.get("/api/orgs");
        expect(organizationsRes.ok()).toBe(true);
        const organizations = await organizationsRes.json();
        return organizations.some(
          (organization: { name: string }) => organization.name === organizationName
        );
      }, {
        timeout: 15_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(false);
  });

  test("new organization drafts are rolled back on reload before launch", async ({
    page,
  }) => {
    const organizationName = `E2E-Draft-Reload-${Date.now()}`;

    await page.goto("/onboarding");
    await expectOnboardingStep(page, "Name your organization");

    await page.locator('input[placeholder="Acme Corp"]').fill(organizationName);
    await page.getByRole("button", { name: "Next" }).click();
    await expectOnboardingStep(page, "Create your first agent");

    await page.reload({ waitUntil: "networkidle" });
    await expectOnboardingStep(page, "Name your organization");

    await expect
      .poll(async () => {
        const organizationsRes = await page.request.get("/api/orgs");
        expect(organizationsRes.ok()).toBe(true);
        const organizations = await organizationsRes.json();
        return organizations.some(
          (organization: { name: string }) => organization.name === organizationName
        );
      }, {
        timeout: 15_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(false);
  });
});
