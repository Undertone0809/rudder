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

function localIso(dateKey: string, hour: number, minute = 0) {
  const value = new Date(`${dateKey}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`);
  return value.toISOString();
}

async function createCalendarOrg(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", { data: { name } });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json();
}

async function createHumanEvent(page: Page, orgId: string, title: string, startAt: string, endAt: string) {
  const response = await page.request.post(`/api/orgs/${orgId}/calendar/events`, {
    data: {
      eventKind: "human_event",
      eventStatus: "planned",
      ownerType: "user",
      title,
      startAt,
      endAt,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      allDay: false,
      visibility: "full",
      sourceMode: "manual",
    },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function createGoogleSource(page: Page, orgId: string, name: string, status: "active" | "paused") {
  const response = await page.request.post(`/api/orgs/${orgId}/calendar/sources`, {
    data: {
      type: "google_calendar",
      name,
      ownerType: "user",
      externalProvider: "google_calendar",
      externalCalendarId: name.toLowerCase().replace(/\s+/g, "-"),
      visibilityDefault: "full",
      status,
    },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function createExternalEvent(page: Page, orgId: string, sourceId: string, title: string, startAt: string, endAt: string) {
  const response = await page.request.post(`/api/orgs/${orgId}/calendar/events`, {
    data: {
      sourceId,
      eventKind: "external_event",
      eventStatus: "external",
      ownerType: "user",
      title,
      startAt,
      endAt,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      allDay: false,
      visibility: "full",
      sourceMode: "imported",
      externalProvider: "google_calendar",
      externalCalendarId: sourceId,
      externalEventId: `${sourceId}-${title}`,
    },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

test.describe("Calendar V1", () => {
  test("uses the workspace shell and keeps Google setup in a compact modal", async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: 1490, height: 1003 });

    const organization = await createCalendarOrg(page, `Calendar-Shell-${Date.now()}`);
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

    await selectOrganization(page, organization.id);
    await page.goto("/calendar");

    await expect(page.getByTestId("workspace-context-card")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("workspace-main-card")).toBeVisible();
    await expect(page.getByTestId("workspace-context-header").getByRole("heading", { name: "Calendar" })).toBeVisible();
    await expect(page.getByText("Layers and sync")).toBeVisible();
    await expect(page.getByTestId("calendar-layers-sidebar")).toHaveCount(0);
    await expect(page.getByTestId("calendar-google-row")).toBeVisible();
    await expect(page.getByText("Imported event titles are visible in Rudder when enabled")).toHaveCount(0);

    await expect(page.getByText("Engineer · Projected heartbeat")).toHaveCount(0);
    await page.getByLabel("Show projected events").click();
    await expect(page.getByText("Engineer · Projected heartbeat").first()).toBeVisible();

    await page.getByTestId("calendar-google-row").click();
    const modal = page.getByRole("dialog", { name: "Google Calendar" });
    await expect(modal).toBeVisible();
    await expect(modal.getByText("Read-only import for the operator calendar.")).toBeVisible();
    await expect(modal.getByText("calendar data never enters agent context")).toBeVisible();

    await modal.getByRole("button", { name: "Connect" }).click();
    await expect(modal.getByText("GOOGLE_CALENDAR_CLIENT_ID")).toBeVisible();
    await expect(modal.getByText("GOOGLE_CALENDAR_CLIENT_SECRET")).toBeVisible();
    await expect(modal.getByText("GOOGLE_CLIENT_ID")).toBeVisible();
    await expect(modal.getByText(`/api/orgs/${organization.id}/calendar/google/callback`)).toBeVisible();
  });

  test("lets operators enable individual Google calendars", async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: 1490, height: 1003 });

    const organization = await createCalendarOrg(page, `Calendar-Google-Sources-${Date.now()}`);
    const todayKey = localDateKey(new Date());
    const workSource = await createGoogleSource(page, organization.id, "Work calendar", "active");
    const personalSource = await createGoogleSource(page, organization.id, "Personal calendar", "paused");
    await createExternalEvent(page, organization.id, workSource.id, "Visible external test event", localIso(todayKey, 9), localIso(todayKey, 10));
    await createExternalEvent(page, organization.id, personalSource.id, "Hidden external test event", localIso(todayKey, 10), localIso(todayKey, 11));

    await selectOrganization(page, organization.id);
    await page.goto("/calendar");

    await expect(page.getByTestId("calendar-google-source-list")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Work calendar")).toBeVisible();
    await expect(page.getByText("Personal calendar")).toBeVisible();
    await expect(page.getByText("Visible external test event")).toBeVisible();
    await expect(page.getByText("Hidden external test event")).toHaveCount(0);

    await page.getByLabel("Enable Personal calendar").click();
    await expect(page.getByText("Hidden external test event")).toBeVisible();

    await page.getByTestId("calendar-google-row").click();
    const modal = page.getByRole("dialog", { name: "Google Calendar" });
    await expect(modal.getByText("Calendars")).toBeVisible();
    await expect(modal.getByText("Work calendar")).toBeVisible();
    await expect(modal.getByText("Personal calendar")).toBeVisible();
  });

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

    await expect(page.getByTestId("workspace-context-header").getByRole("heading", { name: "Calendar" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("CEO (CEO)", { exact: true })).toBeVisible();
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

  test("supports drag-create, writable event move/resize, and non-overlapping timed event columns", async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: 1490, height: 1003 });

    const organization = await createCalendarOrg(page, `Calendar-Interaction-${Date.now()}`);
    const todayKey = localDateKey(new Date());
    const overlapA = await createHumanEvent(page, organization.id, "Overlap A", localIso(todayKey, 13), localIso(todayKey, 14));
    const overlapB = await createHumanEvent(page, organization.id, "Overlap B", localIso(todayKey, 13, 15), localIso(todayKey, 14, 15));
    const overlapC = await createHumanEvent(page, organization.id, "Overlap C", localIso(todayKey, 13, 30), localIso(todayKey, 14, 30));

    await selectOrganization(page, organization.id);
    await page.goto("/calendar");
    await expect(page.getByTestId("workspace-context-header").getByRole("heading", { name: "Calendar" })).toBeVisible({ timeout: 20_000 });

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
    await expect(page.getByTestId(`calendar-create-preview-${todayKey}`)).toBeVisible();
    await popover.getByPlaceholder("Add title").fill("Review CEO output");
    await popover.getByPlaceholder("Add description").fill("Check the agent output before the afternoon review.");

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

    const overlapBoxes = await Promise.all([overlapA.id, overlapB.id, overlapC.id].map(async (eventId) => {
      const eventBox = await page.getByTestId(`calendar-event-${eventId}`).boundingBox();
      if (!eventBox) throw new Error(`Overlap event ${eventId} was not measurable`);
      return eventBox;
    }));
    for (let i = 0; i < overlapBoxes.length; i += 1) {
      for (let j = i + 1; j < overlapBoxes.length; j += 1) {
        const a = overlapBoxes[i]!;
        const b = overlapBoxes[j]!;
        expect(a.x + a.width).toBeLessThanOrEqual(b.x + 1.5);
      }
    }

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
      description: "Check the agent output before the afternoon review.",
    });
    expect(new Date(humanEvent.endAt).getTime() - new Date(humanEvent.startAt).getTime()).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
  });
});
