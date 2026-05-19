import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { E2E_HOME, E2E_INSTANCE_ID } from "./support/e2e-env";

function resolveOrganizationWorkspaceRoot(orgId: string) {
  return path.join(
    E2E_HOME,
    "instances",
    E2E_INSTANCE_ID,
    "organizations",
    orgId,
    "workspaces",
  );
}

test.describe("Issue detail Library docs UX", () => {
  test("renders Library doc mentions and migrated issue docs without issue-owned document creation", async ({ page }) => {
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Issue-Library-Docs-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const libraryDocRes = await page.request.post(`/api/orgs/${organization.id}/library/documents`, {
      data: {
        title: "Product brief",
        format: "markdown",
        body: "# Product brief\n\nThe live Library doc body stays outside issue context.",
      },
    });
    expect(libraryDocRes.ok()).toBe(true);
    const libraryDoc = await libraryDocRes.json() as { id: string };

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Issue should link docs from Library",
        description: `Use [@Product brief](library-doc://${libraryDoc.id}?t=Product%20brief) as the source of truth.`,
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier?: string };

    const legacyDocRes = await page.request.put(`/api/issues/${issue.id}/documents/ops-checklist`, {
      data: {
        title: "Ops checklist",
        format: "markdown",
        body: "Confirm staging is healthy before handoff.",
        baseRevisionId: null,
      },
    });
    expect(legacyDocRes.ok()).toBe(true);

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);

    await expect(page.getByRole("button", { name: "Copy ID" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Attach", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New document" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Focused document editor" })).toHaveCount(0);

    const productBriefLinks = page.getByRole("link", { name: "Product brief" });
    await expect(productBriefLinks.first()).toHaveAttribute("href", new RegExp(`/library\\?doc=${libraryDoc.id}$`));
    await expect(page.getByLabel("Linked Library docs")).toBeVisible();
    await expect(page.getByLabel("Linked Library docs").getByText("Product brief")).toBeVisible();
    await expect(page.getByLabel("Linked Library docs").getByText("Ops checklist")).toBeVisible();

    await productBriefLinks.first().click();
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/library\\?doc=${libraryDoc.id}$`));
    await expect(page.getByTestId("org-library-context-panel").getByDisplayValue("Product brief")).toBeVisible();
    await expect(page.getByText("History", { exact: true })).toBeVisible();
  });

  test("attaches files from the Library file tree", async ({ page }) => {
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Issue-Library-Attach-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string };
    const workspaceRoot = resolveOrganizationWorkspaceRoot(organization.id);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "handoff-notes.md"), "# Handoff notes\n", "utf8");

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Issue can attach Library files",
        description: "Attachments come from the same Library file tree.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier?: string };

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);

    await page.getByRole("button", { name: "Attach", exact: true }).click();
    await page.getByRole("menuitem", { name: "Attach from Library" }).click();
    const libraryDialog = page.getByRole("dialog", { name: "Attach from Library" });
    await expect(libraryDialog).toBeVisible();
    await libraryDialog.getByRole("button", { name: "handoff-notes.md" }).click();
    await libraryDialog.getByRole("button", { name: "Attach" }).click();
    await expect(page.getByRole("link", { name: "handoff-notes.md" })).toBeVisible({ timeout: 5000 });
  });
});
