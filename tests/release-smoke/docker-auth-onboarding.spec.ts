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
const AGENT_NAME = "CEO";
const TASK_TITLE = "Release smoke task";

type IssueCompletionSnapshot = {
  status: string;
  commentCount: number;
  documentCount: number;
  workProductCount: number;
};

async function signIn(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/auth/);

  await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();

  await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
}

async function openOnboarding(page: Page) {
  const wizardHeading = page.locator("h3", { hasText: "Name your company" });
  const startButton = page.getByRole("button", { name: "Start Onboarding" });

  await expect(wizardHeading.or(startButton)).toBeVisible({ timeout: 20_000 });

  if (await startButton.isVisible()) {
    await startButton.click();
  }

  await expect(wizardHeading).toBeVisible({ timeout: 10_000 });
}

test.describe("Docker authenticated onboarding smoke", () => {
  test("logs in, completes onboarding, and triggers the first CEO run", async ({
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

    await expect(page.locator('input[placeholder="CEO"]')).toHaveValue(AGENT_NAME);
    await page.getByRole("button", { name: "Next" }).click();

    await expect(
      page.locator("h3", { hasText: "Give it something to do" })
    ).toBeVisible({ timeout: 10_000 });
    await page
      .locator('input[placeholder="e.g. Research competitor pricing"]')
      .fill(TASK_TITLE);
    await page.getByRole("button", { name: "Next" }).click();

    await expect(
      page.locator("h3", { hasText: "Ready to launch" })
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(COMPANY_NAME)).toBeVisible();
    await expect(page.getByText(AGENT_NAME)).toBeVisible();
    await expect(page.getByText("onboarding", { exact: true })).toBeVisible();
    await expect(page.getByText(TASK_TITLE)).toBeVisible();

    await page.getByRole("button", { name: "Create & Open Issue" }).click();
    await expect(page).toHaveURL(/\/issues\//, { timeout: 10_000 });

    const baseUrl = new URL(page.url()).origin;

    const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesRes.ok()).toBe(true);
    const companies = (await companiesRes.json()) as Array<{ id: string; name: string }>;
    const company = companies.find((entry) => entry.name === COMPANY_NAME);
    expect(company).toBeTruthy();

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
    const ceoAgent = agents.find((entry) => entry.name === AGENT_NAME);
    expect(ceoAgent).toBeTruthy();
    expect(ceoAgent!.role).toBe("ceo");
    expect(ceoAgent!.agentRuntimeType).not.toBe("process");

    const issuesRes = await page.request.get(
      `${baseUrl}/api/companies/${company!.id}/issues`
    );
    expect(issuesRes.ok()).toBe(true);
    const issues = (await issuesRes.json()) as Array<{
      id: string;
      title: string;
      assigneeAgentId: string | null;
      projectId: string | null;
    }>;
    const issue = issues.find((entry) => entry.title === TASK_TITLE);
    expect(issue).toBeTruthy();
    expect(issue!.assigneeAgentId).toBe(ceoAgent!.id);

    const projectsRes = await page.request.get(
      `${baseUrl}/api/companies/${company!.id}/projects`
    );
    expect(projectsRes.ok()).toBe(true);
    const projects = (await projectsRes.json()) as Array<{
      id: string;
      name: string;
      archivedAt?: string | null;
    }>;
    const onboardingProjects = projects.filter(
      (project) => project.name === "onboarding" && !project.archivedAt
    );
    expect(onboardingProjects).toHaveLength(1);
    expect(issue!.projectId).toBe(onboardingProjects[0].id);

    await expect.poll(
      async () => {
        const runsRes = await page.request.get(
          `${baseUrl}/api/companies/${company!.id}/heartbeat-runs?agentId=${ceoAgent!.id}`
        );
        expect(runsRes.ok()).toBe(true);
        const runs = (await runsRes.json()) as Array<{
          agentId: string;
          invocationSource: string;
          status: string;
        }>;
        const latestRun = runs.find((entry) => entry.agentId === ceoAgent!.id);
        return latestRun
          ? {
              invocationSource: latestRun.invocationSource,
              status: latestRun.status,
            }
          : null;
      },
      {
        timeout: 30_000,
        intervals: [1_000, 2_000, 5_000],
      }
    ).toEqual(
      expect.objectContaining({
        invocationSource: "assignment",
        status: expect.stringMatching(/^(queued|running|succeeded|failed)$/),
      })
    );

    await expect.poll(
      async (): Promise<IssueCompletionSnapshot> => {
        const [issueRes, commentsRes, documentsRes, workProductsRes] = await Promise.all([
          page.request.get(`${baseUrl}/api/issues/${issue!.id}`),
          page.request.get(`${baseUrl}/api/issues/${issue!.id}/comments`),
          page.request.get(`${baseUrl}/api/issues/${issue!.id}/documents`),
          page.request.get(`${baseUrl}/api/issues/${issue!.id}/work-products`),
        ]);

        expect(issueRes.ok()).toBe(true);
        expect(commentsRes.ok()).toBe(true);
        expect(documentsRes.ok()).toBe(true);
        expect(workProductsRes.ok()).toBe(true);

        const issueDetail = (await issueRes.json()) as { status: string };
        const comments = (await commentsRes.json()) as Array<unknown>;
        const documents = (await documentsRes.json()) as Array<unknown>;
        const workProducts = (await workProductsRes.json()) as Array<unknown>;

        return {
          status: issueDetail.status,
          commentCount: comments.length,
          documentCount: documents.length,
          workProductCount: workProducts.length,
        };
      },
      {
        timeout: 120_000,
        intervals: [2_000, 5_000, 10_000],
      }
    ).toEqual(
      expect.objectContaining({
        status: "done",
      })
    );

    const completion = await Promise.all([
      page.request.get(`${baseUrl}/api/issues/${issue!.id}/comments`),
      page.request.get(`${baseUrl}/api/issues/${issue!.id}/documents`),
      page.request.get(`${baseUrl}/api/issues/${issue!.id}/work-products`),
    ]).then(async ([commentsRes, documentsRes, workProductsRes]) => {
      const comments = (await commentsRes.json()) as Array<unknown>;
      const documents = (await documentsRes.json()) as Array<unknown>;
      const workProducts = (await workProductsRes.json()) as Array<unknown>;
      return {
        commentCount: comments.length,
        documentCount: documents.length,
        workProductCount: workProducts.length,
      };
    });

    expect(
      completion.commentCount + completion.documentCount + completion.workProductCount
    ).toBeGreaterThan(0);
  });
});
