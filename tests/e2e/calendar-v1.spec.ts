import { expect, test, type Page } from "@playwright/test";

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

test.describe("Calendar V1", () => {
  test("creates a planned agent work block without starting agent runtime work", async ({ page }) => {
    test.slow();

    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Calendar-V1-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "CEO",
        role: "ceo",
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    const issueRes = await page.request.post(`/api/orgs/${organization.id}/issues`, {
      data: {
        title: "Review pricing issue",
        description: "Calendar blocks should be human-facing annotations only.",
        status: "todo",
        priority: "medium",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    await selectOrganization(page, organization.id);
    await page.goto("/calendar");

    await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("CEO", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^week$/i })).toBeVisible();

    await page.getByRole("button", { name: "New block" }).click();
    const dialog = page.getByRole("dialog", { name: "New calendar block" });
    await dialog.getByLabel("Agent", { exact: true }).selectOption(agent.id);
    await dialog.getByLabel("Linked issue", { exact: true }).selectOption(issue.id);
    await dialog.getByRole("textbox", { name: "Start" }).fill("2026-05-01T14:00");
    await dialog.getByRole("textbox", { name: "End" }).fill("2026-05-01T15:00");

    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/orgs/${organization.id}/calendar/events`) &&
      response.ok(),
    );
    await dialog.getByRole("button", { name: "Create block" }).click();
    await createResponse;

    const drawer = page.getByRole("dialog", { name: "CEO · Review pricing issue" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("planned", { exact: true })).toBeVisible();
    await expect(drawer.getByText("manual", { exact: true })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Open issue" })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Open agent" })).toBeVisible();

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^agenda$/i }).click();
    await expect(page.getByText("CEO · Review pricing issue").first()).toBeVisible();

    const eventsRes = await page.request.get(`/api/orgs/${organization.id}/calendar/events`, {
      params: {
        start: "2026-05-01T00:00:00.000Z",
        end: "2026-05-02T00:00:00.000Z",
      },
    });
    expect(eventsRes.ok()).toBe(true);
    const eventsBody = await eventsRes.json();
    expect(eventsBody.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventKind: "agent_work_block",
          eventStatus: "planned",
          sourceMode: "manual",
          ownerAgentId: agent.id,
          issueId: issue.id,
          title: "CEO · Review pricing issue",
        }),
      ]),
    );
    const plannedEvent = eventsBody.events.find((event: { title?: string }) =>
      event.title === "CEO · Review pricing issue",
    );
    if (!plannedEvent) throw new Error("Expected planned calendar event to be returned");

    const patchRes = await page.request.patch(`/api/orgs/${organization.id}/calendar/events/${plannedEvent.id}`, {
      data: { title: "CEO · Review pricing issue (renamed)" },
    });
    expect(patchRes.ok()).toBe(true);
    expect(await patchRes.json()).toMatchObject({
      id: plannedEvent.id,
      title: "CEO · Review pricing issue (renamed)",
      ownerAgentId: agent.id,
      issueId: issue.id,
      eventKind: "agent_work_block",
      sourceMode: "manual",
    });

    const heartbeatRunsRes = await page.request.get(`/api/orgs/${organization.id}/heartbeat-runs`, {
      params: { agentId: agent.id },
    });
    expect(heartbeatRunsRes.ok()).toBe(true);
    expect(await heartbeatRunsRes.json()).toEqual([]);
  });
});
