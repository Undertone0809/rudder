import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { E2E_HOME, E2E_INSTANCE_ID } from "./support/e2e-env";

const ORG_NAME = `Issue-Detail-UX-${Date.now()}`;

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

test.describe("Issue detail documents UX", () => {
  test("shows a section outline in the focused document editor", async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Issue-Detail-Outline-${Date.now()}` },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Document outline should use the right rail",
        description: "Focused documents should expose their chapter list.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    const documentRes = await page.request.put(`/api/issues/${issue.id}/documents/proposal`, {
      data: {
        title: "Proposal",
        format: "markdown",
        body: [
          "# Overview",
          "",
          "## 1. 摘要",
          "The first section should appear in the outline.",
          "",
          "### Decision details",
          "Nested headings should stay visible.",
        ].join("\n"),
        baseRevisionId: null,
      },
    });
    expect(documentRes.ok()).toBe(true);

    await page.goto(`/issues/${issue.identifier ?? issue.id}`);
    await page.locator("#document-proposal").getByRole("button", { name: "Expand editor" }).click();

    const focusedEditor = page.getByRole("region", { name: "Focused document editor" });
    await expect(focusedEditor.getByText("Sections", { exact: true })).toBeVisible();
    await expect(focusedEditor.getByRole("button", { name: "Overview" })).toBeVisible();
    await expect(focusedEditor.getByRole("button", { name: "1. 摘要" })).toBeVisible();
    await expect(focusedEditor.getByRole("button", { name: "Decision details" })).toBeVisible();

    await focusedEditor.getByRole("button", { name: "Decision details" }).click();
    await expect(focusedEditor.getByRole("heading", { name: "Decision details" })).toBeVisible();
  });

  test("keeps document creation user-facing and exposes copyable issue id", async ({ page }) => {
    await page.goto("/");

    const orgRes = await page.request.post("/api/orgs", {
      data: { name: ORG_NAME },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(organization.id);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "handoff-notes.md"), "# Handoff notes\n", "utf8");

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
    const focusedEditor = page.getByRole("region", { name: "Focused document editor" });
    await expect(page.getByPlaceholder("Document key")).toHaveCount(0);
    await expect(focusedEditor.getByPlaceholder("Untitled document")).toBeVisible();
    await expect(page.getByText("Add some content before creating the document")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(focusedEditor.getByRole("button", { name: "Back to issue" })).toBeVisible();
    await expect(focusedEditor.getByRole("button", { name: "Done" })).toHaveCount(0);
    await expect(focusedEditor.getByRole("button", { name: "Discard" })).toHaveCount(0);
    await expect(focusedEditor.getByRole("button", { name: "Create" })).toHaveCount(0);

    await focusedEditor.getByPlaceholder("Untitled document").fill("Release notes");
    const editor = focusedEditor.locator('[contenteditable="true"]');
    await editor.click();
    await editor.fill("Summarize what changed before handoff.");
    await expect(focusedEditor.getByText("Draft", { exact: true })).toHaveCount(0);
    await expect(focusedEditor.getByText("Created", { exact: true })).toHaveCount(0);
    await expect(focusedEditor.getByText("Saved", { exact: true })).toBeVisible({ timeout: 5000 });

    await focusedEditor.getByRole("button", { name: "Back to issue" }).click();
    await expect(page.getByText("Release notes")).toBeVisible();
    await expect(page.getByText("Document key", { exact: true })).toHaveCount(0);

    await page.locator("#document-ops-checklist").getByRole("button", { name: "Expand editor" }).click();
    const focusedExistingEditor = page.getByRole("region", { name: "Focused document editor" });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(focusedExistingEditor.getByRole("button", { name: "Done" })).toHaveCount(0);
    await expect(focusedExistingEditor.getByRole("button", { name: "Discard" })).toHaveCount(0);
    await expect(focusedExistingEditor.getByRole("button", { name: "Back to issue" })).toBeVisible();
    await expect(page.getByText("Sub-issues")).toHaveCount(0);
    await focusedExistingEditor.getByPlaceholder("Untitled document").fill("Ops checklist revised");
    await expect(focusedExistingEditor.getByText("Ops checklist revised")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Sub-issues")).toBeVisible();

    await page.getByRole("button", { name: "Attach", exact: true }).click();
    await page.getByRole("menuitem", { name: "Attach from Workspaces" }).click();
    const workspaceDialog = page.getByRole("dialog", { name: "Attach from Workspaces" });
    await expect(workspaceDialog).toBeVisible();
    await workspaceDialog.getByRole("button", { name: "handoff-notes.md" }).click();
    await workspaceDialog.getByRole("button", { name: "Attach" }).click();
    await expect(page.getByRole("link", { name: "handoff-notes.md" })).toBeVisible({ timeout: 5000 });
  });
});
