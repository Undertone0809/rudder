import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createDb, workspaceBackups } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL, E2E_HOME, E2E_INSTANCE_ID } from "./support/e2e-env";

test.use({ serviceWorkers: "block" });

const e2eDb = createDb(E2E_DATABASE_URL);

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
  await expect(page.getByText("Every 24h")).toBeVisible();
  await expect(page.getByText("30 days")).toBeVisible();
  await expect(page.getByTestId("workspace-main-card").getByText("Versions")).toBeVisible();
  await expect(page.getByText("1 backup")).toBeVisible();

  await page.getByRole("button", { name: "plans" }).click();
  await page.getByRole("button", { name: "roadmap.md" }).click();
  await expect(page.getByText("# Roadmap")).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Restore workspace backup");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Restore" }).click();
  await expect.poll(async () => fs.readFile(path.join(workspaceRoot, "plans", "roadmap.md"), "utf8"))
    .toBe("# Roadmap\n");
  await expect(page.getByText("2 backups")).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Delete workspace backup");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Delete" }).click();
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
