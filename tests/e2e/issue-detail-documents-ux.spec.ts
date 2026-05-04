import { expect, test } from "@playwright/test";

const ORG_NAME = `Issue-Detail-UX-${Date.now()}`;

test.describe("Issue detail documents UX", () => {
  test("keeps document creation user-facing and exposes copyable issue id", async ({ page }) => {
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: ORG_NAME },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Issue detail should stay compact",
        description: "Document editing should not expose implementation details.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    const documentRes = await page.request.put(`/api/issues/${issue.id}/documents/ops-checklist`, {
      data: {
        title: "Ops checklist",
        format: "markdown",
        body: "Confirm staging is healthy before handoff.",
        baseRevisionId: null,
      },
    });
    expect(documentRes.ok()).toBe(true);

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);

    await expect(page.getByRole("button", { name: "Copy ID" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Attach", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "New document" }).click();
    await expect(page.getByPlaceholder("Document title")).toBeVisible();
    await expect(page.getByPlaceholder("Document key")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Expand editor" })).toBeVisible();

    await page.getByRole("button", { name: "Expand editor" }).click();
    await expect(page.getByText("Add some content before creating the document")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Back to issue" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Done" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Discard" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create" })).toHaveCount(0);

    await page.getByPlaceholder("Untitled document").fill("Release notes");
    const editor = page.locator('[contenteditable="true"]').last();
    await editor.click();
    await editor.fill("Summarize what changed before handoff.");
    await expect(page.getByText(/Created|Saved/)).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: "Back to issue" }).click();
    await expect(page.getByText("Release notes")).toBeVisible();
    await expect(page.getByText("Document key", { exact: true })).toHaveCount(0);

    await page.locator("#document-ops-checklist").getByRole("button", { name: "Expand editor" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Done" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Discard" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Back to issue" })).toBeVisible();
    await expect(page.getByText("Sub-issues")).toHaveCount(0);
    await page.getByPlaceholder("Untitled document").fill("Ops checklist revised");
    await expect(page.getByText("Ops checklist revised")).toBeVisible();
  });
});
