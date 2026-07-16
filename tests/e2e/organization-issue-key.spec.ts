import { expect, test } from "@playwright/test";

test.describe("Organization issue identity", () => {
  test("keeps issue keys internal while preserving compatible issue links", async ({ page }) => {
    const suffix = Date.now().toString().slice(-6);
    const organizationName = `R6 E2E ${suffix}`;
    const initialKey = "R6E";
    const originalKey = `R6${suffix}`;
    const nextKey = `N6${suffix}`;

    await page.goto("/onboarding");
    await page.locator('input[placeholder="Acme Corp"]').fill(organizationName);
    await expect(page.getByRole("textbox", { name: "Issue key" })).toHaveCount(0);

    const createOrganizationResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith("/api/orgs")
      && response.ok(),
    );
    await page.getByRole("button", { name: "Next" }).click();
    const createdOrganization = await (await createOrganizationResponse).json() as {
      id: string;
      issuePrefix: string;
      urlKey: string;
    };
    expect(createdOrganization.issuePrefix).toBe("R6E");
    await expect(page.getByText("Create your first agent", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Codex" }).click();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\/messenger(?:\/chat)?$/, { timeout: 30_000 });

    await page.goto(`/${createdOrganization.urlKey}/organization/settings`);
    await expect(page.getByRole("textbox", { name: "Issue key" })).toHaveCount(0);
    await expect(page.getByText("Issue key", { exact: true })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Description" }).fill("Issue identity stays internal");
    const initialUpdateResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && response.url().includes(`/api/orgs/${createdOrganization.id}`)
      && response.ok(),
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    const generalSettingsRequest = (await initialUpdateResponse).request();
    expect(generalSettingsRequest.postDataJSON()).toMatchObject({
      description: "Issue identity stays internal",
    });
    expect(generalSettingsRequest.postDataJSON()).not.toHaveProperty("issuePrefix");

    const initialMigrationResponse = await page.request.patch(`/api/orgs/${createdOrganization.id}`, {
      data: { issuePrefix: originalKey },
    });
    expect(initialMigrationResponse.ok()).toBe(true);

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
    await expect(page.getByRole("textbox", { name: "Issue key" })).toHaveCount(0);
    await expect(page.getByText("Issue key", { exact: true })).toHaveCount(0);
    const updateResponse = await page.request.patch(`/api/orgs/${organization!.id}`, {
      data: { issuePrefix: nextKey },
    });
    expect(updateResponse.ok()).toBe(true);
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
