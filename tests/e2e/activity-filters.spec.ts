import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

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
});
