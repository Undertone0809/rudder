import { test, expect, type Page } from "@playwright/test";

const SKIP_LLM = process.env.RUDDER_E2E_SKIP_LLM !== "false";

const GETTING_STARTED_TITLES = [
  "👋 Welcome to Rudder — work with agents like a team",
  "1. Understand how Rudder work happens",
  "2. Ask your agent one quick question",
  "3. Create and run your first agent issue",
  "4. Review the result and close the loop",
  "5. Create a project and add shared resources",
  "6. Add shared context your agent should remember",
  "7. Bring one real task into Rudder",
  "8. Link this work to a goal",
  "9. Capture one reusable workflow",
  "10. Add a second agent with a different role",
  "11. Set up a recurring loop or automation",
];

function onboardingHeading(page: Page, text: string) {
  return page.locator("h3", { hasText: text });
}

async function expectOnboardingStep(page: Page, text: string) {
  await expect(onboardingHeading(page, text)).toBeVisible({ timeout: 15_000 });
}

async function expectSelectedCodexModel(page: Page) {
  const modelButton = page.getByRole("button", { name: /gpt-5\.\d+/ });
  await expect(modelButton).toBeVisible();
  const model = (await modelButton.textContent())?.trim();
  expect(model).toMatch(/^gpt-5\.\d+$/);
  return model!;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMarkdownHref(markdown: string, label: string) {
  const escapedLabel = escapeRegExp(label);
  const match = markdown.match(new RegExp(`\\[${escapedLabel}\\]\\(([^)]+)\\)`));
  expect(match?.[1]).toBeTruthy();
  return match![1]!;
}

test.describe("Onboarding wizard", () => {
  test("fresh onboarding creates a Getting Started project and opens dashboard", async ({
    page,
  }) => {
    const initialOrganizationName = `E2E-Fresh-${Date.now()}`;
    const updatedOrganizationName = `${initialOrganizationName}-Updated`;
    const updatedAgentName = "Founding CEO";

    await page.goto("/onboarding");

    await expectOnboardingStep(page, "Name your organization");
    await expect(page.getByRole("checkbox", { name: /new to Rudder/i })).toBeChecked();

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
    const selectedCodexModel = await expectSelectedCodexModel(page);
    await onboardingNameInput.fill(updatedAgentName);

    await page.getByRole("button", { name: "Create & Open Dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

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
    expect(page.url()).toContain(`/${organization.issuePrefix}/dashboard`);
    expect(organization).not.toHaveProperty("defaultChatAgentRuntimeType");
    expect(organization).not.toHaveProperty("defaultChatAgentRuntimeConfig");

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
    expect(ceoAgent.agentRuntimeConfig.model).toBe(selectedCodexModel);

    const projectsRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/projects`
    );
    expect(projectsRes.ok()).toBe(true);
    const projects = await projectsRes.json();
    const gettingStartedProjects = projects.filter(
      (project: { name: string; archivedAt?: string | null }) =>
        project.name === "Getting Started" && !project.archivedAt
    );
    expect(gettingStartedProjects).toHaveLength(1);
    const gettingStartedProject = gettingStartedProjects[0];

    const issuesRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/issues?projectId=${gettingStartedProject.id}`
    );
    expect(issuesRes.ok()).toBe(true);
    const issues = await issuesRes.json() as Array<{
      title: string;
      status: string;
      priority: string;
      assigneeAgentId: string | null;
      assigneeUserId: string | null;
      projectId: string | null;
      id: string;
      identifier?: string | null;
      description: string | null;
    }>;
    expect(issues.map((issue) => issue.title).sort()).toEqual(
      [...GETTING_STARTED_TITLES].sort()
    );
    const issueByTitle = new Map(issues.map((issue) => [issue.title, issue]));
    expect(issueByTitle.get(GETTING_STARTED_TITLES[0]!)?.status).toBe("done");
    for (const title of GETTING_STARTED_TITLES.slice(1, 6)) {
      expect(issueByTitle.get(title)?.status).toBe("todo");
      expect(issueByTitle.get(title)?.priority).toBe("high");
    }
    for (const title of GETTING_STARTED_TITLES.slice(6)) {
      expect(issueByTitle.get(title)?.status).toBe("backlog");
    }
    const nextIssueSource = issueByTitle.get("1. Understand how Rudder work happens");
    const nextIssueTarget = issueByTitle.get("2. Ask your agent one quick question");
    expect(nextIssueSource).toBeTruthy();
    expect(nextIssueTarget).toBeTruthy();
    const nextIssueHref = extractMarkdownHref(
      nextIssueSource?.description ?? "",
      "2. Ask your agent one quick question",
    );
    const nextIssueUrl = new URL(nextIssueHref, baseUrl);
    expect(nextIssueUrl.pathname).toBe(
      `/${organization.issuePrefix}/issues/${encodeURIComponent(nextIssueTarget!.identifier ?? nextIssueTarget!.id)}`,
    );
    const chatIssue = issueByTitle.get("2. Ask your agent one quick question");
    expect(chatIssue).toBeTruthy();
    const chatIssueDescription = chatIssue?.description ?? "";
    const chatCtaHref = extractMarkdownHref(chatIssueDescription, "Start from this prompt");
    const chatCtaUrl = new URL(chatCtaHref, baseUrl);
    expect(chatCtaUrl.pathname).toBe(`/${organization.issuePrefix}/messenger/chat`);
    expect(chatIssueDescription).toContain(`projectId=${gettingStartedProject.id}`);
    expect(chatIssueDescription).toContain(`agentId=${ceoAgent.id}`);
    expect(chatCtaUrl.searchParams.get("projectId")).toBe(gettingStartedProject.id);
    expect(chatCtaUrl.searchParams.get("agentId")).toBe(ceoAgent.id);
    const expectedPrefill = chatCtaUrl.searchParams.get("prefill");
    expect(expectedPrefill).toBeTruthy();
    for (const issue of issues) {
      expect(issue.projectId).toBe(gettingStartedProject.id);
      expect(issue.assigneeAgentId).toBeNull();
      expect(issue.assigneeUserId).toBeTruthy();
    }

    await page.goto(`/${organization.issuePrefix}/issues?projectId=${gettingStartedProject.id}`);
    await expect(page.getByText("Welcome", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Core loop", { exact: true })).toBeVisible();
    await expect(page.getByText("Recommended next", { exact: true })).toBeVisible();
    await expect(page.getByText("Advanced", { exact: true })).toBeVisible();

    await page.goto(
      `/${organization.issuePrefix}/issues/${encodeURIComponent(nextIssueSource!.identifier ?? nextIssueSource!.id)}`,
    );
    await expect(page.getByRole("heading", { name: nextIssueSource!.title })).toBeVisible({
      timeout: 15_000,
    });
    const nextIssueLink = page.getByRole("link", { name: "2. Ask your agent one quick question" });
    await expect(nextIssueLink).toHaveAttribute("href", nextIssueHref);
    await nextIssueLink.click();
    await expect(page).toHaveURL(
      new RegExp(
        `/${escapeRegExp(organization.issuePrefix)}/issues/${escapeRegExp(nextIssueTarget!.identifier ?? nextIssueTarget!.id)}$`,
      ),
      { timeout: 15_000 },
    );
    await expect(page.getByRole("heading", { name: nextIssueTarget!.title })).toBeVisible({
      timeout: 15_000,
    });

    await page.goto(`/${organization.issuePrefix}/issues/${encodeURIComponent(chatIssue!.identifier ?? chatIssue!.id)}`);
    await expect(page.getByRole("heading", { name: chatIssue!.title })).toBeVisible({ timeout: 15_000 });
    const chatCta = page.getByRole("link", { name: "Start from this prompt" });
    await expect(chatCta).toHaveAttribute("href", chatCtaHref);
    await chatCta.click();
    await expect(page).toHaveURL(
      new RegExp(`/${escapeRegExp(organization.issuePrefix)}/messenger/chat(?:\\?|$)`),
      { timeout: 15_000 },
    );
    await expect(page.locator(".chat-composer")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("chat-agent-selector")).toContainText(ceoAgent.name, { timeout: 15_000 });
    await expect(page.getByTestId("chat-project-selector")).toContainText("Getting Started", { timeout: 15_000 });
    await expect(page.locator(".chat-composer [contenteditable='true']").first()).toContainText(expectedPrefill!, { timeout: 15_000 });
    await expect(page.locator(".chat-warning")).toHaveCount(0);
  });

  test("getting started seed can create only the welcome issue for experienced users", async ({
    page,
  }) => {
    await page.goto("/onboarding");
    const baseUrl = new URL(page.url()).origin;

    const createRes = await page.request.post(`${baseUrl}/api/orgs`, {
      data: { name: `E2E-Experienced-${Date.now()}` },
    });
    expect(createRes.ok()).toBe(true);
    const organization = await createRes.json();

    const seedRes = await page.request.post(
      `${baseUrl}/api/orgs/${organization.id}/onboarding/getting-started`,
      { data: { includeTutorial: false } },
    );
    expect(seedRes.ok()).toBe(true);
    const seed = await seedRes.json();
    expect(seed.includeTutorial).toBe(false);
    expect(seed.issues.map((issue: { title: string }) => issue.title)).toEqual([
      "👋 Welcome to Rudder — work with agents like a team",
    ]);

    const projectsRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/projects`
    );
    expect(projectsRes.ok()).toBe(true);
    const projects = await projectsRes.json();
    const gettingStartedProject = projects.find(
      (project: { name: string; archivedAt?: string | null }) =>
        project.name === "Getting Started" && !project.archivedAt
    );
    expect(gettingStartedProject).toBeTruthy();

    const issuesRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/issues?projectId=${gettingStartedProject.id}`
    );
    expect(issuesRes.ok()).toBe(true);
    const issues = await issuesRes.json();
    expect(issues.map((issue: { title: string }) => issue.title)).toEqual([
      "👋 Welcome to Rudder — work with agents like a team",
    ]);
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
    const agentName = await onboardingNameInput.inputValue();

    await expect(
      page.locator('[data-testid="onboarding-step-tab-4"]')
    ).toBeDisabled();

    await page.getByRole("button", { name: "Codex" }).click();
    await expectSelectedCodexModel(page);

    await page.getByRole("button", { name: "Test now" }).click();
    await expect(
      page.getByText("Passed")
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

    await expect(
      page.locator('[data-testid="onboarding-launch-summary-task"]')
    ).toContainText(taskTitle);

    await page.getByRole("button", { name: "Create & Open Issue" }).click();
    await expect(page).toHaveURL(/\/issues\//, { timeout: 10_000 });

    const baseUrl = page.url().split("/").slice(0, 3).join("/");
    const agentsRes = await page.request.get(
      `${baseUrl}/api/orgs/${organization.id}/agents`
    );
    expect(agentsRes.ok()).toBe(true);
    const agents = await agentsRes.json();
    const ceoAgent = agents.find(
      (agent: { name: string }) => agent.name === agentName
    );
    expect(ceoAgent).toBeTruthy();

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
    expect(task.projectId).toBeNull();

    if (!SKIP_LLM) {
      await expect(async () => {
        const res = await page.request.get(`${baseUrl}/api/issues/${task.id}`);
        const issue = await res.json();
        expect(["in_progress", "done"]).toContain(issue.status);
      }).toPass({ timeout: 120_000, intervals: [5_000] });
    }
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
