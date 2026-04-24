import { expect, test } from "@playwright/test";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import { createDb, issues } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

function formatInput(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test.describe("Dashboard date filter", () => {
  test("filters recent tasks with 7D, 1M, and custom ranges", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Dashboard-Date-Filter-${Date.now()}`,
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      issuePrefix: string;
    };

    const recentIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Recent dashboard task",
      },
    });
    expect(recentIssueRes.ok()).toBe(true);
    const recentIssue = await recentIssueRes.json() as { id: string };

    const olderIssueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Older dashboard task",
      },
    });
    expect(olderIssueRes.ok()).toBe(true);
    const olderIssue = await olderIssueRes.json() as { id: string };

    const now = new Date();
    const recentDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 11, 0, 0, 0);
    const olderDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 16, 11, 0, 0, 0);

    await e2eDb.update(issues).set({
      createdAt: recentDate,
      updatedAt: recentDate,
    }).where(eq(issues.id, recentIssue.id));
    await e2eDb.update(issues).set({
      createdAt: olderDate,
      updatedAt: olderDate,
    }).where(eq(issues.id, olderIssue.id));

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/dashboard`, {
      waitUntil: "domcontentloaded",
    });

    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByRole("button", { name: "7D" })).toBeVisible();
    await expect(mainContent.getByRole("button", { name: "1M" })).toBeVisible();
    await expect(mainContent.getByRole("button", { name: /Custom/ })).toBeVisible();

    await expect(mainContent.getByText("Recent dashboard task")).toBeVisible();
    await expect(mainContent.getByText("Older dashboard task")).toHaveCount(0);
    await expect(mainContent.getByText("Last 7 days · relative daily run volume · hover for details")).toBeVisible();

    await mainContent.getByRole("button", { name: "1M" }).click();
    await expect(mainContent.getByText("Older dashboard task")).toBeVisible();
    await expect(mainContent.getByText("Last 30 days · relative daily run volume · hover for details")).toBeVisible();

    await mainContent.getByRole("button", { name: /Custom/ }).click();
    const fromInput = page.getByLabel("From");
    const toInput = page.getByLabel("To");
    await fromInput.fill(formatInput(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 20)));
    await toInput.fill(formatInput(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 14)));

    await expect(mainContent.getByText("Older dashboard task")).toBeVisible();
    await expect(mainContent.getByText("Recent dashboard task")).toHaveCount(0);
  });
});
