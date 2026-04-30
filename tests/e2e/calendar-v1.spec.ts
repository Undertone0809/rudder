import { expect, test, type Page } from "@playwright/test";

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function createCalendarOrg(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", { data: { name } });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

test.describe("Calendar V1", () => {
  test("creates a planned agent work block as a read-only human-facing annotation", async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: 1490, height: 1003 });

    const organization = await createCalendarOrg(page, `Calendar-Agent-Block-${Date.now()}`);

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
    await expect(page.getByTestId("calendar-layers-sidebar")).toBeVisible();
    await expect(page.getByText("Read-only import. Events default to busy blocks and never enter agent context.")).toBeVisible();
    await expect(page.getByText("not connected")).toBeVisible();
    await expect(page.getByText("CEO", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^week$/i })).toBeVisible();

    await page.getByRole("button", { name: "Create" }).click();
    const popover = page.getByTestId("calendar-quick-create");
    await expect(popover).toBeVisible();
    await popover.getByRole("button", { name: "Agent block" }).click();
    await popover.getByLabel("Agent", { exact: true }).selectOption(agent.id);
    await popover.getByLabel("Linked issue", { exact: true }).selectOption(issue.id);
    await popover.getByLabel("Start", { exact: true }).fill("2026-05-01T14:00");
    await popover.getByLabel("End", { exact: true }).fill("2026-05-01T15:00");

    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/orgs/${organization.id}/calendar/events`) &&
      response.ok(),
    );
    await popover.getByRole("button", { name: "Save" }).click();
    await createResponse;

    const drawer = page.getByRole("dialog", { name: "CEO · Review pricing issue" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("planned", { exact: true })).toBeVisible();
    await expect(drawer.getByText("manual", { exact: true })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Open issue" })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Open agent" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: /Edit calendar/i })).toHaveCount(0);
    await expect(drawer.getByText("Only My Calendar events can be edited.")).toBeVisible();

    const eventsRes = await page.request.get(`/api/orgs/${organization.id}/calendar/events`, {
      params: {
        start: "2026-05-01T00:00:00.000Z",
        end: "2026-05-02T00:00:00.000Z",
      },
    });
    expect(eventsRes.ok()).toBe(true);
    const eventsBody = await eventsRes.json();
    const plannedEvent = eventsBody.events.find((event: { title?: string }) =>
      event.title === "CEO · Review pricing issue",
    );
    expect(plannedEvent).toMatchObject({
      eventKind: "agent_work_block",
      eventStatus: "planned",
      sourceMode: "manual",
      ownerAgentId: agent.id,
      issueId: issue.id,
    });

    const patchRes = await page.request.patch(`/api/orgs/${organization.id}/calendar/events/${plannedEvent.id}`, {
      data: { title: "CEO · Review pricing issue (renamed)" },
    });
    expect(patchRes.status()).toBe(409);

    const heartbeatRunsRes = await page.request.get(`/api/orgs/${organization.id}/heartbeat-runs`, {
      params: { agentId: agent.id },
    });
    expect(heartbeatRunsRes.ok()).toBe(true);
    expect(await heartbeatRunsRes.json()).toEqual([]);
  });

  test("supports sidebar collapse, drag-to-create, move, resize, and projected heartbeats", async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: 1490, height: 1003 });

    const organization = await createCalendarOrg(page, `Calendar-Interaction-${Date.now()}`);
    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Engineer",
        role: "engineer",
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 3600,
          },
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    await selectOrganization(page, organization.id);
    await page.goto("/calendar");
    await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Hide calendar sidebar" }).click();
    await expect(page.getByTestId("calendar-layers-sidebar")).toHaveCount(0);
    await page.getByRole("button", { name: "Show calendar sidebar" }).click();
    await expect(page.getByTestId("calendar-layers-sidebar")).toBeVisible();

    const todayKey = localDateKey(new Date());
    const dayColumn = page.getByTestId(`calendar-day-column-${todayKey}`);
    await expect(dayColumn).toBeVisible();
    const box = await dayColumn.boundingBox();
    if (!box) throw new Error("Calendar day column was not measurable");

    await page.mouse.move(box.x + 72, box.y + 9 * 52 + 4);
    await page.mouse.down();
    await page.mouse.move(box.x + 72, box.y + 10 * 52 + 4);
    await page.mouse.up();

    const popover = page.getByTestId("calendar-quick-create");
    await expect(popover).toBeVisible();
    await popover.getByPlaceholder("Add title").fill("Review CEO output");

    const createResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/orgs/${organization.id}/calendar/events`) &&
      response.ok(),
    );
    await popover.getByRole("button", { name: "Save" }).click();
    await createResponse;
    await expect(page.getByText("Review CEO output").first()).toBeVisible();
    await page.keyboard.press("Escape");

    const eventBlock = page.locator('[data-testid^="calendar-event-"]').filter({ hasText: "Review CEO output" }).first();
    await expect(eventBlock).toBeVisible();
    const eventBox = await eventBlock.boundingBox();
    if (!eventBox) throw new Error("Created calendar event was not measurable");

    const moveResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      response.url().includes(`/api/orgs/${organization.id}/calendar/events/`) &&
      response.ok(),
    );
    await page.mouse.move(eventBox.x + eventBox.width / 2, eventBox.y + eventBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(eventBox.x + eventBox.width / 2, eventBox.y + eventBox.height / 2 + 52);
    await page.mouse.up();
    await moveResponse;

    const movedBlock = page.locator('[data-testid^="calendar-event-"]').filter({ hasText: "Review CEO output" }).first();
    const movedBox = await movedBlock.boundingBox();
    if (!movedBox) throw new Error("Moved calendar event was not measurable");
    const resizeResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      response.url().includes(`/api/orgs/${organization.id}/calendar/events/`) &&
      response.ok(),
    );
    await page.mouse.move(movedBox.x + movedBox.width / 2, movedBox.y + movedBox.height - 2);
    await page.mouse.down();
    await page.mouse.move(movedBox.x + movedBox.width / 2, movedBox.y + movedBox.height + 52);
    await page.mouse.up();
    await resizeResponse;

    const today = new Date();
    const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const dayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2).toISOString();
    const eventsRes = await page.request.get(`/api/orgs/${organization.id}/calendar/events`, {
      params: {
        start: dayStart,
        end: dayEnd,
      },
    });
    expect(eventsRes.ok()).toBe(true);
    const eventsBody = await eventsRes.json();
    const humanEvent = eventsBody.events.find((event: { title?: string }) => event.title === "Review CEO output");
    expect(humanEvent).toMatchObject({
      eventKind: "human_event",
      eventStatus: "planned",
      sourceMode: "manual",
    });
    expect(new Date(humanEvent.endAt).getTime() - new Date(humanEvent.startAt).getTime()).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);

    const projected = eventsBody.events.find((event: { eventStatus?: string; ownerAgentId?: string }) =>
      event.eventStatus === "projected" && event.ownerAgentId === agent.id,
    );
    expect(projected).toMatchObject({
      eventKind: "agent_work_block",
      eventStatus: "projected",
      sourceMode: "derived",
      title: "Engineer · Projected heartbeat",
    });

    await page.getByText("Engineer · Projected heartbeat").first().click();
    const projectedDrawer = page.getByRole("dialog", { name: "Engineer · Projected heartbeat" });
    await expect(projectedDrawer).toBeVisible();
    await expect(projectedDrawer.getByText("projected heartbeat")).toBeVisible();
    await expect(projectedDrawer.getByRole("button", { name: /Edit calendar/i })).toHaveCount(0);

    const heartbeatRunsRes = await page.request.get(`/api/orgs/${organization.id}/heartbeat-runs`, {
      params: { agentId: agent.id },
    });
    expect(heartbeatRunsRes.ok()).toBe(true);
    expect(await heartbeatRunsRes.json()).toEqual([]);
  });
});
