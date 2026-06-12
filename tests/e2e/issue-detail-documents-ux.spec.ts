import { expect, test } from "@playwright/test";

test.describe("Issue detail Library UX", () => {
  test("renders explicit Library mentions without issue-owned document cards", async ({ page }) => {
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Issue-Docs-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const libraryDocRes = await page.request.post(`/api/orgs/${organization.id}/library/documents`, {
      data: {
        title: "Product brief",
        format: "markdown",
        body: "# Product brief\n\nThe live Doc body stays outside issue context.",
      },
    });
    expect(libraryDocRes.ok()).toBe(true);
    const libraryDoc = await libraryDocRes.json() as { id: string };
    const workspaceFileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: "docs/product-brief.md",
        content: "# Product brief\n",
      },
    });
    expect(workspaceFileRes.ok()).toBe(true);

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Issue should link docs from Library",
        description: [
          `Use [@Product brief](library-doc://${libraryDoc.id}?t=Product%20brief) as the durable source.`,
          "Use [@product-brief.md](library-file://file?p=docs%2Fproduct-brief.md&t=product-brief.md) as the live file source.",
        ].join("\n\n"),
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json() as { id: string; identifier?: string };

    const retiredDocRes = await page.request.put(`/api/issues/${issue.id}/documents/ops-checklist`, {
      data: {
        title: "Ops checklist",
        format: "markdown",
        body: "Confirm staging is healthy before handoff.",
        baseRevisionId: null,
      },
    });
    expect(retiredDocRes.status()).toBe(410);

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);

    await expect(page.getByRole("button", { name: "Copy ID" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Attach", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New document" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Focused document editor" })).toHaveCount(0);

    const productBriefMention = page.getByRole("link", { name: "Product brief" }).first();
    await expect(productBriefMention).toHaveAttribute("href", new RegExp(`/library\\?doc=${libraryDoc.id}$`));
    const fileMention = page.getByRole("link", { name: "product-brief.md" }).first();
    await expect(fileMention).toBeVisible();
    await expect(fileMention).toHaveAttribute("href", new RegExp(`/library\\?path=docs%2Fproduct-brief\\.md$`));
    await expect(fileMention).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(fileMention).toHaveCSS("border-top-style", "none");

    await expect(page.getByLabel("Linked Library")).toBeVisible();
    await expect(page.getByLabel("Linked Library").locator('[data-testid="linked-library-resource-icon"][data-kind="file"]')).toHaveCount(1);
    await expect(page.getByLabel("Linked Library").locator('[data-testid="linked-library-resource-icon"][data-kind="doc"]')).toHaveCount(1);
    await expect(page.getByLabel("Linked Library").getByText("Product brief")).toBeVisible();
    await expect(page.getByLabel("Linked Library").getByRole("link", { name: "product-brief.md live Library" })).toBeVisible();
    await expect(page.getByLabel("Linked Library").getByText("Ops checklist")).toHaveCount(0);
    await expect(page.getByLabel("Linked Library").getByRole("link", { name: "product-brief.md live Library" }))
      .toHaveAttribute("href", new RegExp(`/library\\?path=docs%2Fproduct-brief\\.md$`));

    await page.getByLabel("Linked Library").getByRole("link", { name: "Product brief live Library link" }).click();
    await expect(page).toHaveURL(new RegExp(`/library\\?doc=${libraryDoc.id}$`));
    await expect(page.getByTestId("org-workspaces-files-card")).toBeVisible();
    await expect(page.getByTestId("org-library-resources-panel")).toHaveCount(0);

  });

  test("attaches files from the Library file tree", async ({ page }) => {
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Issue-Docs-Attach-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string };
    const workspaceFileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: "handoff-notes.md",
        content: "# Handoff notes\n",
      },
    });
    expect(workspaceFileRes.ok()).toBe(true);

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
