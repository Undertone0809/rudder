import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createDb, workspaceBackups } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";
import { resolveE2EOrganizationWorkspaceRoot } from "./support/organization-storage";

test.use({ serviceWorkers: "block" });

const e2eDb = createDb(E2E_DATABASE_URL);

const resolveOrganizationWorkspaceRoot = resolveE2EOrganizationWorkspaceRoot;

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

test("browses, restores, and deletes workspace backup versions", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `Workspace-Backups-${Date.now()}`,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();
  const workspaceRoot = resolveOrganizationWorkspaceRoot(organization.id);
  await fs.mkdir(path.join(workspaceRoot, "plans"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "plans", "roadmap.md"), "# Roadmap\n", "utf8");

  const backupRes = await page.request.post(`/api/orgs/${organization.id}/workspace/backups`, {
    data: { triggerSource: "manual" },
  });
  expect(backupRes.ok()).toBe(true);
  await fs.writeFile(path.join(workspaceRoot, "plans", "roadmap.md"), "# Changed\n", "utf8");

  await selectOrganization(page, organization.id);
  await page.goto(`/${organization.issuePrefix}/workspaces/backups`);

  await expect(page.getByRole("heading", { name: "Workspace backups" })).toBeVisible();
  await expect(page.getByTestId("primary-rail")).toBeVisible();
  await expect(page.getByTestId("workspace-context-card")).toBeVisible();
  await expect(page.getByTestId("workspace-main-card")).toBeVisible();
  await expect(page.getByTestId("workspace-sidebar").getByRole("heading", { name: "Files" })).toBeVisible();
  await expect(page.getByText("Policy")).toBeVisible();
  await expect(page.getByText("Every 2h")).toBeVisible();
  await expect(page.getByText("After 24h offline")).toBeVisible();
  await expect(page.getByText("30 days")).toBeVisible();
  await expect(page.getByTestId("workspace-main-card").getByText("Versions")).toBeVisible();
  await expect(page.getByText("1 backup")).toBeVisible();

  await page.getByTestId("workspace-main-header-actions").getByRole("link", { name: "Back to library" }).click();
  await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/library(?:\\?|$)`));
  await expect(page.getByRole("button", { name: "Hide Library sidebar" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No file selected" })).toBeVisible();
  await page.goto(`/${organization.issuePrefix}/workspaces/backups`);

  await page.getByRole("button", { name: "plans" }).click();
  await page.getByRole("button", { name: "roadmap.md" }).click();
  await expect(page.getByText("# Roadmap")).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download" }).click();
  const downloadedBackup = await download;
  expect(downloadedBackup.suggestedFilename()).toMatch(/^workspace-.*\.zip$/);
  const downloadedPath = await downloadedBackup.path();
  expect(downloadedPath).toBeTruthy();
  const downloadedArtifact = await fs.readFile(downloadedPath!);
  expect(downloadedArtifact.subarray(0, 4).toString("binary")).toBe("PK\u0003\u0004");
  const zipText = downloadedArtifact.toString("utf8");
  expect(zipText).toContain("plans/roadmap.md");
  expect(zipText).toContain("# Roadmap\n");

  await page.getByRole("button", { name: "Restore" }).click();
  const restoreDialog = page.getByRole("dialog", { name: "Restore workspace backup" });
  await expect(restoreDialog).toBeVisible();
  await restoreDialog.getByRole("button", { name: "Restore" }).click();
  await expect.poll(async () => fs.readFile(path.join(workspaceRoot, "plans", "roadmap.md"), "utf8"))
    .toBe("# Roadmap\n");
  await expect(page.getByText("2 backups")).toBeVisible();

  await page.getByRole("button", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete workspace backup" });
  await expect(deleteDialog).toBeVisible();
  await deleteDialog.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("1 backup")).toBeVisible();
  await expect(page.getByTestId("workspace-main-card").getByText("pre restore").first()).toBeVisible();
});

test("shows failed workspace backups without requesting missing artifacts", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `Workspace-Backups-Failed-${Date.now()}`,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json();

  const failedBackupId = randomUUID();
  await e2eDb.insert(workspaceBackups).values({
    id: failedBackupId,
    orgId: organization.id,
    status: "failed",
    triggerSource: "scheduled",
    artifactProvider: "local_file",
    artifactRef: path.join(resolveOrganizationWorkspaceRoot(organization.id), "missing-backup.json"),
    error: "Maximum call stack size exceeded",
    startedAt: new Date(),
    finishedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await selectOrganization(page, organization.id);
  await page.goto(`/${organization.issuePrefix}/workspaces/backups`);

  await expect(page.getByRole("heading", { name: "Workspace backups" })).toBeVisible();
  await expect(page.getByTestId("workspace-sidebar").getByText("Backup failed: Maximum call stack size exceeded")).toBeVisible();
  await expect(page.getByTestId("workspace-main-card").getByText("This backup failed: Maximum call stack size exceeded")).toBeVisible();
  await expect(page.getByText("Workspace backup artifact not found")).toBeHidden();
  await expect(page.getByRole("button", { name: "Restore" })).toBeDisabled();
});
