import { expect, test } from "@playwright/test";

test.describe("Organization issue key identity", () => {
  test("creates a numeric issue key and preserves old links after migration", async ({ page }) => {
    const suffix = Date.now().toString().slice(-6);
    const organizationName = `R6 E2E ${suffix}`;
    const initialKey = `I6${suffix}`;
    const originalKey = `R6${suffix}`;
    const nextKey = `N6${suffix}`;

    await page.goto("/onboarding");
    await page.locator('input[placeholder="Acme Corp"]').fill(organizationName);
    await expect(page.getByRole("textbox", { name: "Issue key" })).toHaveValue("R6E");
    await page.getByRole("textbox", { name: "Issue key" }).fill(initialKey);

    const createOrganizationResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith("/api/orgs")
      && response.ok(),
    );
    await page.getByRole("button", { name: "Next" }).click();
    await createOrganizationResponse;
    await expect(page.getByText("Create your first agent", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("textbox", { name: "Issue key" }).fill(originalKey);
    await expect(page.getByText(`Used in issue IDs, for example ${originalKey}-1. It must be unique.`)).toBeVisible();
    const updateDraftResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes("/api/orgs/")
      && response.ok(),
    );
    await page.getByRole("button", { name: "Next" }).click();
    await updateDraftResponse;

    const organizationsResponse = await page.request.get("/api/orgs");
    const organizations = await organizationsResponse.json() as Array<{
      id: string;
      name: string;
      issuePrefix: string;
      urlKey: string;
    }>;
    const organization = organizations.find((candidate) => candidate.name === organizationName);
    expect(organization).toBeTruthy();
    expect(organization!.issuePrefix).toBe(originalKey);

    await page.getByRole("button", { name: "Codex" }).click();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\/messenger(?:\/chat)?$/, { timeout: 30_000 });

    const routeNamespaceName = `ACME${suffix}`;
    const routeNamespaceResponse = await page.request.post("/api/orgs", {
      data: { name: routeNamespaceName, issuePrefix: `C${suffix}` },
    });
    expect(routeNamespaceResponse.ok()).toBe(true);
    const routeKeyConflictResponse = await page.request.post("/api/orgs", {
      data: { name: `Route conflict ${suffix}`, issuePrefix: routeNamespaceName },
    });
    expect(routeKeyConflictResponse.status()).toBe(409);

    const issueResponse = await page.request.post(`/api/orgs/${organization!.id}/issues`, {
      data: { title: "Issue key migration proof", status: "todo", priority: "medium" },
    });
    expect(issueResponse.ok()).toBe(true);
    const issue = await issueResponse.json() as { id: string; identifier: string };
    const issueNumber = issue.identifier.slice(originalKey.length + 1);
    expect(issue.identifier).toBe(`${originalKey}-${issueNumber}`);

    const conflictResponse = await page.request.post("/api/orgs", {
      data: { name: `Conflicting ${suffix}`, issuePrefix: originalKey },
    });
    expect(conflictResponse.status()).toBe(409);
    await expect(conflictResponse.json()).resolves.toMatchObject({
      error: `Issue key "${originalKey}" is already in use. Choose another key.`,
    });

    await page.goto(`/${organization!.urlKey}/organization/settings`);
    const issueKeyInput = page.getByRole("textbox", { name: "Issue key" });
    await expect(issueKeyInput).toHaveValue(originalKey);
    await issueKeyInput.fill(nextKey);
    const updateResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/orgs/${organization!.id}`)
      && response.ok(),
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    await updateResponse;
    await expect(issueKeyInput).toHaveValue(nextKey);
    await expect(page).toHaveURL(new RegExp(`/${organization!.urlKey}/organization/settings$`));

    const currentIssueResponse = await page.request.get(`/api/issues/${nextKey}-${issueNumber}`);
    expect(currentIssueResponse.ok()).toBe(true);
    expect((await currentIssueResponse.json()).id).toBe(issue.id);
    const historicalIssueResponse = await page.request.get(`/api/issues/${originalKey}-${issueNumber}`);
    expect(historicalIssueResponse.ok()).toBe(true);
    expect((await historicalIssueResponse.json()).id).toBe(issue.id);

    await page.goto(`/${nextKey}/organization/settings`);
    await expect(page).toHaveURL(new RegExp(`/${organization!.urlKey}/organization/settings$`));

    await page.goto(`/${originalKey}/issues/${originalKey}-${issueNumber}`);
    await expect(page).toHaveURL(new RegExp(`/${organization!.urlKey}/issues/${nextKey}-${issueNumber}$`));
    await expect(page.getByRole("heading", { name: "Issue key migration proof" })).toBeVisible();

    await page.goto(`/${organization!.urlKey}/organization/import`);
    const skipTourButton = page.getByRole("button", { name: "Skip tour" });
    if (await skipTourButton.isVisible()) {
      await skipTourButton.click();
    }
    const importOrganizationName = page.locator('input[placeholder="Imported Organization"]');
    const importIssueKey = page.getByRole("textbox", { name: "New organization Issue Key" });
    await importOrganizationName.fill("R6 Import");
    await expect(importIssueKey).toHaveValue("R6I");
    await importIssueKey.fill("Z9");
    await importOrganizationName.fill("Import renamed");
    await expect(importIssueKey).toHaveValue("Z9");
  });
});
