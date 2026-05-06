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
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const reviewerRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Review Bot",
        role: "reviewer",
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
    await dialog.getByRole("button", { name: "Review Bot" }).click();

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
});
