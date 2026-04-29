import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

const ORG_NAME = `Issue-Detail-Toolbar-${Date.now()}`;

test.describe("Issue detail toolbar actions", () => {
  test("keeps desktop issue actions consolidated into a single right-side group", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: ORG_NAME },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Issue actions should not repeat",
        description: "Desktop issue detail should keep repeated actions in one place.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);

    await expect(page.getByRole("button", { name: "Copy ID" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Chat" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "More issue actions" })).toHaveCount(1);
    await expect(page.getByText("Properties", { exact: true })).toBeVisible();
  });

  test("opens issue chat as a prefilled new chat without creating an empty conversation", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `${ORG_NAME}-Issue-Chat-Prefill` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const issueRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Issue chat should prefill",
        description: "Clicking Chat should mention this issue in a new composer.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier: string | null };
    expect(issue.identifier).toBeTruthy();

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues/${issue.identifier ?? issue.id}`);
    await page.getByRole("button", { name: "Chat", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/messenger/chat(?:\\?.*)?$`));
    await expect.poll(() => page.url()).not.toContain("prefill=");

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await expect(composer).toContainText(issue.identifier!);

    const chatsRes = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/chats?status=all`);
    expect(chatsRes.ok()).toBe(true);
    const conversations = await chatsRes.json() as unknown[];
    expect(conversations).toHaveLength(0);
  });

  test("opens project chat as a prefilled new chat without creating an empty conversation", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `${ORG_NAME}-Project-Chat-Prefill` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const projectRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Rudder Dev Chat Prefill",
        status: "planned",
        color: "#ff7a1a",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; name: string };

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/projects/${project.id}`);
    await page.getByRole("button", { name: "Chat", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/messenger/chat(?:\\?.*)?$`));
    await expect.poll(() => page.url()).not.toContain("prefill=");

    const composer = page.locator(".rudder-mdxeditor-content").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await expect(composer).toContainText(project.name);

    const chatsRes = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/chats?status=all`);
    expect(chatsRes.ok()).toBe(true);
    const conversations = await chatsRes.json() as unknown[];
    expect(conversations).toHaveLength(0);
  });

  test("shows default labels for issues in newly created organizations", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `${ORG_NAME}-Labels` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Label defaults should be seeded",
        description: "New organizations should expose built-in issue labels immediately.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);

    await page.getByRole("button", { name: /No labels/i }).click();

    await expect(page.getByPlaceholder("Search labels...")).toBeVisible();
    await expect(page.getByRole("button", { name: "Bug", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Feature", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "UI", exact: true })).toBeVisible();
  });

  test("uses a search-first label picker with inline create results", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `${ORG_NAME}-Inline-Create` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Label picker should inline create",
        description: "Issue detail should create labels from search results, not a footer form.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);
    await page.getByRole("button", { name: /No labels/i }).click();

    await expect(page.getByRole("button", { name: /^Create label "/ })).toHaveCount(0);
    await expect(page.locator('button[title^="Delete "]')).toHaveCount(0);

    const searchInput = page.getByPlaceholder("Search labels...");
    await searchInput.fill("Customer escalation");
    await expect(page.getByRole("button", { name: 'Create label "Customer escalation"' })).toBeVisible();

    const createLabelResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/orgs/${organization.id}/labels`) &&
      response.ok(),
    );
    const patchIssueResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      /\/api\/issues\/[^/]+$/.test(response.url()) &&
      response.ok(),
    );
    await page.getByRole("button", { name: 'Create label "Customer escalation"' }).click();
    await createLabelResponse;
    await patchIssueResponse;

    await expect(page.getByText("Customer escalation", { exact: true })).toBeVisible();
  });
});
