import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test.describe("Issue reviewer routing", () => {
  test("creates an issue with a reviewer and shows it on issue detail", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Issue-Reviewer-Routing-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };

    const reviewerRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Review Bot",
        role: "cto",
        title: "Chief Technology Officer",
      },
    });
    expect(reviewerRes.ok()).toBe(true);
    const reviewer = await reviewerRes.json() as { id: string; name: string };

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues`);
    await page.getByTestId("workspace-main-header").getByRole("button", { name: "Create Issue" }).click();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder("Issue title").fill("Reviewer routed issue");
    await dialog.getByRole("button", { name: "Reviewer" }).click();
    await dialog.getByPlaceholder("Search reviewers...").fill("Review Bot");
    const reviewerBadge = dialog.locator('[data-slot="agent-menu-supporting-label"]').filter({ hasText: "Chief Technology Officer" });
    await expect(reviewerBadge.first()).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Review Bot (Chief Technology Officer)" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Review Bot" }).click();
    await expect(reviewerBadge.first()).toBeVisible();

    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/orgs/${organization.id}/issues`) &&
      response.ok(),
    );
    await dialog.getByRole("button", { name: "Create Issue" }).click();
    const createdIssue = await (await createResponse).json() as { id: string; identifier: string; reviewerAgentId: string | null };

    expect(createdIssue.reviewerAgentId).toBe(reviewer.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues/${createdIssue.identifier}`);
    await expect(page.getByText("Reviewer", { exact: true })).toBeVisible();
    await expect(page.getByText("Review Bot", { exact: true })).toBeVisible();
  });

  test("does not show a duplicate-assignee indicator when reviewer and assignee match", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `Issue-Reviewer-Matching-Assignee-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };

    const agentRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Shared Owner Reviewer",
        role: "engineer",
        title: "Shared owner and reviewer",
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string; name: string };

    const issueRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Matching reviewer and assignee",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agent.id,
        reviewerAgentId: agent.id,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { identifier: string };

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues/${issue.identifier}`);
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/issues/${issue.identifier}$`));
    const properties = page.getByRole("region", { name: "Issue properties" });
    await expect(properties).toBeVisible();
    await expect(properties.getByText(agent.name, { exact: true })).toHaveCount(2);
    await expect(properties.getByText("Same as assignee", { exact: true })).toHaveCount(0);
  });

  test("returns needs-followup review work to todo and preserves it after reload", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `Issue-Reviewer-Follow-Up-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };

    const assigneeRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: { name: "Follow-up Owner", role: "engineer", title: "Follow-up owner" },
    });
    expect(assigneeRes.ok()).toBe(true);
    const assignee = await assigneeRes.json() as { id: string };

    const reviewerRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: { name: "Follow-up Reviewer", role: "cto", title: "Follow-up reviewer" },
    });
    expect(reviewerRes.ok()).toBe(true);
    const reviewer = await reviewerRes.json() as { id: string };

    const issueRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Needs follow-up lifecycle",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: assignee.id,
        reviewerAgentId: reviewer.id,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier: string };

    const reviewRes = await page.request.patch(`${E2E_BASE_URL}/api/issues/${issue.id}`, {
      data: {
        reviewDecision: "needs_followup",
        comment: "Please continue this work from the Todo queue.",
      },
    });
    expect(reviewRes.ok()).toBe(true);
    expect((await reviewRes.json() as { status: string }).status).toBe("todo");

    const repeatedReviewRes = await page.request.patch(`${E2E_BASE_URL}/api/issues/${issue.id}`, {
      data: {
        reviewDecision: "needs_followup",
        comment: "Duplicate follow-up must not create another transition.",
      },
    });
    expect(repeatedReviewRes.status()).toBe(422);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues/${issue.identifier}`);
    await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/issues/${issue.identifier}$`));
    const properties = page.getByRole("region", { name: "Issue properties" });
    await expect(properties.locator('[data-slot="issue-status-icon"]')).toHaveAttribute("data-status", "todo");
    await page.reload();
    await expect(properties.locator('[data-slot="issue-status-icon"]')).toHaveAttribute("data-status", "todo");
    await expect(page.getByText("Please continue this work from the Todo queue.", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Duplicate follow-up must not create another transition.", { exact: true })).toHaveCount(0);
  });
});
