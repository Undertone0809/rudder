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
  "👋 Welcome to Rudder — quick reference",
  "1. Run one real task",
  "2. Review the result and close the loop",
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
  const wizardHeading = page.getByRole("heading", { name: "Name your organization" });
  const startButton = page.getByRole("button", { name: "Start Onboarding" });

  if (!(await wizardHeading.isVisible({ timeout: 20_000 }).catch(() => false))) {
    await expect(startButton).toBeVisible({ timeout: 20_000 });
    await startButton.click();
  }

  await expect(wizardHeading).toBeVisible({ timeout: 10_000 });
}

test.describe("Docker authenticated onboarding smoke", () => {
  test("logs in, completes onboarding, and opens messenger", async ({
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
    await page.getByRole("button", { name: "Codex" }).click();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\/messenger(?:\/chat)?$/, { timeout: 90_000 });

    const baseUrl = new URL(page.url()).origin;

    const companiesRes = await page.request.get(`${baseUrl}/api/orgs`);
    expect(companiesRes.ok()).toBe(true);
    const companies = (await companiesRes.json()) as Array<{
      id: string;
      issuePrefix: string;
      urlKey: string;
      name: string;
    }>;
    const company = companies.find((entry) => entry.name === COMPANY_NAME);
    expect(company).toBeTruthy();
    expect(page.url()).toContain(`/${company!.urlKey}/messenger`);

    const agentsRes = await page.request.get(
      `${baseUrl}/api/orgs/${company!.id}/agents`
    );
    expect(agentsRes.ok()).toBe(true);
    const agents = (await agentsRes.json()) as Array<{
      id: string;
      name: string;
      role: string;
      title: string | null;
      agentRuntimeType: string;
    }>;
    const rootAgent = agents.find((entry) => entry.name === agentName);
    expect(rootAgent).toBeTruthy();
    expect(rootAgent!.role).toBe("ceo");
    expect(rootAgent!.title).toBe("Operator Assistant");
    expect(rootAgent!.agentRuntimeType).not.toBe("process");

    const projectsRes = await page.request.get(
      `${baseUrl}/api/orgs/${company!.id}/projects`
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
      `${baseUrl}/api/orgs/${company!.id}/issues?projectId=${gettingStartedProjects[0]!.id}`
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
    expect(issues.filter((issue) => issue.status === "todo")).toHaveLength(2);
    expect(issues.filter((issue) => issue.status === "backlog")).toHaveLength(0);
    for (const issue of issues) {
      expect(issue.assigneeAgentId).toBeNull();
      expect(issue.assigneeUserId).toBeTruthy();
      expect(issue.projectId).toBe(gettingStartedProjects[0]!.id);
    }
  });
});
