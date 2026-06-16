import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

test.describe("Organization activity filters", () => {
  test("filters the activity feed by agent and user", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Activity Filters ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Agentic Auditor",
        role: "qa",
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const userActorId = `filter-user-${Date.now()}`;
    const userTitle = `User filtered event ${Date.now()}`;
    const agentTitle = `Agent filtered event ${Date.now()}`;

    const userActivityRes = await page.request.post(`/api/orgs/${organization.id}/activity`, {
      data: {
        actorType: "user",
        actorId: userActorId,
        action: "project.updated",
        entityType: "project",
        entityId: randomUUID(),
        details: { title: userTitle },
      },
    });
    expect(userActivityRes.ok()).toBe(true);

    const agentActivityRes = await page.request.post(`/api/orgs/${organization.id}/activity`, {
      data: {
        actorType: "agent",
        actorId: agent.id,
        agentId: agent.id,
        action: "project.updated",
        entityType: "project",
        entityId: randomUUID(),
        details: { title: agentTitle },
      },
    });
    expect(agentActivityRes.ok()).toBe(true);

    await page.goto(`/${organization.issuePrefix}/activity`);

    await expect(page.getByText(userTitle)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(agentTitle)).toBeVisible();

    await page.getByRole("combobox", { name: "Filter by actor" }).click();
    await page.getByRole("option", { name: "Agentic Auditor" }).click();

    await expect(page.getByText(agentTitle)).toBeVisible();
    await expect(page.getByText(userTitle)).toHaveCount(0);

    await page.getByRole("combobox", { name: "Filter by actor" }).click();
    await page.getByRole("option", { name: `User ${userActorId.slice(0, 8)}` }).click();

    await expect(page.getByText(userTitle)).toBeVisible();
    await expect(page.getByText(agentTitle)).toHaveCount(0);
  });

  test("loads organization activity incrementally as the user scrolls", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Activity Infinite ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const oldestTitle = `Oldest incremental activity ${Date.now()}`;
    const newestTitle = `Newest incremental activity ${Date.now()}`;

    for (let index = 0; index < 45; index += 1) {
      const title = index === 0
        ? oldestTitle
        : index === 44
          ? newestTitle
          : `Incremental activity ${index} ${Date.now()}`;
      const res = await page.request.post(`/api/orgs/${organization.id}/activity`, {
        data: {
          actorType: "system",
          actorId: "activity-e2e",
          action: "project.updated",
          entityType: "project",
          entityId: randomUUID(),
          details: { title },
        },
      });
      expect(res.ok()).toBe(true);
    }

    const activityRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/api/orgs/${organization.id}/activity`) {
        activityRequests.push(`${url.searchParams.get("limit") ?? ""}:${url.searchParams.has("cursor")}`);
      }
    });

    await page.goto(`/${organization.issuePrefix}/activity`);

    await expect(page.getByText(newestTitle)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(oldestTitle)).toHaveCount(0);
    await expect.poll(() => activityRequests.some((entry) => entry === "30:false")).toBe(true);

    await page.locator("#main-content").evaluate((element) => {
      element.scrollTo(0, element.scrollHeight);
    });

    await expect(page.getByText(oldestTitle)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => activityRequests.some((entry) => entry === "30:true")).toBe(true);
  });
});
