import { expect, test, type Page } from "@playwright/test";

const ADMIN_EMAIL =
  process.env.RUDDER_RELEASE_SMOKE_EMAIL ??
  process.env.SMOKE_ADMIN_EMAIL ??
  "smoke-admin@rudder.local";
const ADMIN_PASSWORD =
  process.env.RUDDER_RELEASE_SMOKE_PASSWORD ??
  process.env.SMOKE_ADMIN_PASSWORD ??
  "rudder-smoke-password";

const COMPANY_NAME = `Release-Smoke-${Date.now()}`;
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
async function signIn(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/auth/);

  await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();

  await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
}

async function openOnboarding(page: Page) {
  const wizardHeading = page.locator("h3", { hasText: "Name your organization" });
  const startButton = page.getByRole("button", { name: "Start Onboarding" });

  await expect(wizardHeading.or(startButton)).toBeVisible({ timeout: 20_000 });

  if (await startButton.isVisible()) {
    await startButton.click();
  }

  await expect(wizardHeading).toBeVisible({ timeout: 10_000 });
}

test.describe("Docker authenticated onboarding smoke", () => {
  test("logs in, completes onboarding, and opens the dashboard", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await signIn(page);
    await openOnboarding(page);

    await page.locator('input[placeholder="Acme Corp"]').fill(COMPANY_NAME);
    await page.getByRole("button", { name: "Next" }).click();

    await expect(
      page.locator("h3", { hasText: "Create your first agent" })
    ).toBeVisible({ timeout: 10_000 });

    const agentNameInput = page.locator('input[placeholder="Agent name"]');
    await expect(agentNameInput).toHaveValue(/\S+/, { timeout: 15_000 });
    const agentName = await agentNameInput.inputValue();
    await page.getByRole("button", { name: "Create & Open Dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 10_000 });

    const baseUrl = new URL(page.url()).origin;

    const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesRes.ok()).toBe(true);
    const companies = (await companiesRes.json()) as Array<{
      id: string;
      issuePrefix: string;
      name: string;
    }>;
    const company = companies.find((entry) => entry.name === COMPANY_NAME);
    expect(company).toBeTruthy();
    expect(page.url()).toContain(`/${company!.issuePrefix}/dashboard`);

    const agentsRes = await page.request.get(
      `${baseUrl}/api/companies/${company!.id}/agents`
    );
    expect(agentsRes.ok()).toBe(true);
    const agents = (await agentsRes.json()) as Array<{
      id: string;
      name: string;
      role: string;
      agentRuntimeType: string;
    }>;
    const ceoAgent = agents.find((entry) => entry.name === agentName);
    expect(ceoAgent).toBeTruthy();
    expect(ceoAgent!.role).toBe("ceo");
    expect(ceoAgent!.agentRuntimeType).not.toBe("process");

    const projectsRes = await page.request.get(
      `${baseUrl}/api/companies/${company!.id}/projects`
    );
    expect(projectsRes.ok()).toBe(true);
    const projects = (await projectsRes.json()) as Array<{
      id: string;
      name: string;
      archivedAt?: string | null;
    }>;
    const gettingStartedProjects = projects.filter(
      (project) => project.name === "Getting Started" && !project.archivedAt
    );
    expect(gettingStartedProjects).toHaveLength(1);

    const issuesRes = await page.request.get(
      `${baseUrl}/api/companies/${company!.id}/issues?projectId=${gettingStartedProjects[0]!.id}`
    );
    expect(issuesRes.ok()).toBe(true);
    const issues = (await issuesRes.json()) as Array<{
      title: string;
      status: string;
      assigneeAgentId: string | null;
      assigneeUserId: string | null;
      projectId: string | null;
    }>;
    expect(issues.map((issue) => issue.title).sort()).toEqual(
      [...GETTING_STARTED_TITLES].sort()
    );
    expect(issues.find((issue) => issue.title === GETTING_STARTED_TITLES[0])?.status).toBe("done");
    expect(issues.filter((issue) => issue.status === "todo")).toHaveLength(5);
    expect(issues.filter((issue) => issue.status === "backlog")).toHaveLength(6);
    for (const issue of issues) {
      expect(issue.assigneeAgentId).toBeNull();
      expect(issue.assigneeUserId).toBeTruthy();
      expect(issue.projectId).toBe(gettingStartedProjects[0]!.id);
    }
  });
});
