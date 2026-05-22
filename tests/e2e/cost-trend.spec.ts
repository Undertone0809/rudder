import { expect, test } from "@playwright/test";

function daysAgoUtc(days: number): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days, 12, 0, 0, 0));
  return date.toISOString();
}

test.describe("Cost trend chart", () => {
  test("shows token volume and estimated spend on the organization costs page", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Cost-Trend-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Cost Analyst",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    for (const event of [
      { inputTokens: 600, cachedInputTokens: 150, outputTokens: 250, costCents: 123, occurredAt: daysAgoUtc(0) },
      { inputTokens: 300, cachedInputTokens: 50, outputTokens: 450, costCents: 456, occurredAt: daysAgoUtc(0) },
    ]) {
      const eventRes = await page.request.post(`/api/orgs/${organization.id}/cost-events`, {
        data: {
          agentId: agent.id,
          provider: "openai",
          biller: "openai",
          billingType: "metered_api",
          model: "gpt-5.4",
          ...event,
        },
      });
      expect(eventRes.ok()).toBe(true);
    }

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/costs`, { waitUntil: "domcontentloaded" });

    const chart = page.getByTestId("cost-trend-chart");
    await expect(chart).toBeVisible();
    await expect(chart.getByText("Inference trend")).toBeVisible();
    await expect(chart.getByText("Tokens", { exact: true })).toBeVisible();
    await expect(chart.getByText("1.8k")).toBeVisible();
    await expect(chart.getByText("Estimated spend", { exact: true })).toBeVisible();
    await expect(chart.getByText("$5.79")).toBeVisible();
  });

  test("loads month-to-date costs when token aggregates exceed the Postgres int4 range", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Cost-Overflow-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "large-token-project",
        status: "in_progress",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; name: string };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Large Token Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    for (const costCents of [101, 202, 303]) {
      const eventRes = await page.request.post(`/api/orgs/${organization.id}/cost-events`, {
        data: {
          agentId: agent.id,
          projectId: project.id,
          provider: "openai",
          biller: "openai",
          billingType: "metered_api",
          model: "gpt-5.4",
          inputTokens: 900_000_000,
          cachedInputTokens: 0,
          outputTokens: 1_000,
          costCents,
          occurredAt: daysAgoUtc(0),
        },
      });
      expect(eventRes.ok()).toBe(true);
    }

    await page.addInitScript((orgId: string) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/costs`, { waitUntil: "domcontentloaded" });

    await expect(page.getByText("Internal server error")).toHaveCount(0);
    await expect(page.getByTestId("cost-trend-chart")).toBeVisible();
    await expect(page.getByText("2.7B tokens across request-scoped events", { exact: true })).toBeVisible();
    await expect(page.getByText("large-token-project", { exact: true })).toBeVisible();
  });
});
