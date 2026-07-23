import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createE2EChatAgent } from "./support/chat-agent";

function uniqueIssuePrefix() {
  return `L${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`;
}

async function createOrganization(request: APIRequestContext) {
  const response = await request.post("/api/orgs", {
    data: { name: `Local-Apps-${Date.now()}`, issuePrefix: uniqueIssuePrefix() },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function createChat(page: Page, orgId: string) {
  await createE2EChatAgent(page.request, orgId, { name: "Local Apps host agent" });
  const response = await page.request.post(`/api/orgs/${orgId}/chats`, {
    data: {
      title: "Local Apps work package",
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "Review the local marketing dashboard." },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<{ id: string }>;
}

async function selectOrganization(page: Page, orgId: string) {
  await page.addInitScript((selectedOrganizationId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrganizationId);
    window.localStorage.setItem("rudder.messengerThreadOrganizationByOrg", JSON.stringify({
      [selectedOrganizationId]: "custom",
    }));
  }, orgId);
}

async function installLocalAppsStub(page: Page) {
  await page.addInitScript(() => {
    const definitionsKey = "e2e.localApps.definitions";
    const statusKey = "e2e.localApps.status";
    const callsKey = "e2e.localApps.calls";
    const definition = {
      id: "definition-a",
      desktopInstallationId: "installation-a",
      appPublicId: "public-a",
      localBindingId: "binding-a",
      title: "MKT dashboard",
      executable: "/opt/homebrew/bin/npm",
      argv: ["run", "dev"],
      cwd: "/Users/zeeland/projects/uranus/rudder/mkt/dashboard",
      inheritedEnvNames: ["RUDDER_GROWTH_DB_PATH", "RUDDER_MAIL_DB_PATH"],
      readiness: { path: "/api/health", timeoutMs: 30_000 },
      openPath: "/outreach",
      trustFingerprint: "fingerprint-a",
      approvedFingerprint: "fingerprint-a",
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    };
    const readDefinitions = () => JSON.parse(
      window.localStorage.getItem(definitionsKey) ?? "[]",
    ) as Array<typeof definition>;
    const writeDefinitions = (next: Array<typeof definition>) => {
      window.localStorage.setItem(definitionsKey, JSON.stringify(next));
    };
    const record = (name: string) => {
      const current = JSON.parse(
        window.localStorage.getItem(callsKey) ?? "{}",
      ) as Record<string, number>;
      current[name] = (current[name] ?? 0) + 1;
      window.localStorage.setItem(callsKey, JSON.stringify(current));
    };
    const runtime = (
      status: string,
      generation: string | null = null,
      error?: string,
    ) => ({
      status,
      generation,
      ...(error ? { error } : {}),
    });
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        getBrowserPartition: async () => "persist:rudder-browser-v1-local-apps-e2e",
        localApps: {
          supported: true,
          list: async () => {
            record("list");
            return readDefinitions();
          },
          discover: async () => {
            record("discover");
            return {
              canceled: false,
              draft: {
                title: definition.title,
                executable: definition.executable,
                argv: definition.argv,
                cwd: definition.cwd,
                inheritedEnvNames: definition.inheritedEnvNames,
                readiness: definition.readiness,
                openPath: definition.openPath,
                trustFingerprint: definition.trustFingerprint,
              },
            };
          },
          create: async (draft: typeof definition) => {
            record("create");
            const created = { ...definition, ...draft };
            writeDefinitions([created]);
            return created;
          },
          update: async (id: string, draft: typeof definition) => {
            record("update");
            const updated = {
              ...definition,
              ...draft,
              id,
              updatedAt: "2026-07-23T01:00:00.000Z",
            };
            writeDefinitions([updated]);
            return updated;
          },
          delete: async () => {
            record("delete");
            writeDefinitions([]);
          },
          start: async () => {
            record("start");
            const next = runtime("running", "generation-a");
            window.localStorage.setItem(statusKey, JSON.stringify(next));
            return next;
          },
          stop: async () => {
            record("stop");
            const next = runtime("stopped");
            window.localStorage.setItem(statusKey, JSON.stringify(next));
            return next;
          },
          status: async () => {
            record("status");
            return JSON.parse(window.localStorage.getItem(statusKey) ?? "null")
              ?? runtime("stopped");
          },
          logs: async () => {
            record("logs");
            return [
              "MKT dashboard fixture log",
              "listener restricted to 127.0.0.1",
            ];
          },
          attestedTarget: async () => {
            record("attestedTarget");
            const status = JSON.parse(
              window.localStorage.getItem(statusKey) ?? "null",
            ) as { status?: string } | null;
            return status?.status === "running"
              ? {
                  origin: "http://127.0.0.1:43123",
                  openPath: "/outreach",
                  partition: "persist:rudder-local-app-e2e",
                }
              : null;
          },
        },
      },
    });
  });
}

async function calls(page: Page) {
  return page.evaluate(() => JSON.parse(
    window.localStorage.getItem("e2e.localApps.calls") ?? "{}",
  ) as Record<string, number>);
}

async function groups(page: Page, orgId: string) {
  const response = await page.request.get(`/api/orgs/${orgId}/messenger/groups`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<{ groups: Array<{
    id: string;
    entries: Array<{
      itemKey: string;
      item: { type: "thread" } | {
        type: "saved_view";
        savedView: {
          id: string;
          title: string;
          targetPayload: Record<string, unknown>;
        };
      };
    }>;
  }> }>;
}

function activeMainTab(page: Page) {
  return page
    .getByTestId("messenger-main-workbench")
    .locator('[role="tab"][aria-selected="true"]');
}

async function closeActiveMainTab(page: Page) {
  const tab = activeMainTab(page);
  const tabLabel = (await tab.locator("span").textContent())?.trim() ?? "New tab";
  await tab.locator("..").getByRole("button", {
    name: `Close ${tabLabel} tab`,
  }).click();
}

test.describe("Messenger Local Apps", () => {
  test("shares Browser capacity across Main and cold-restores canonical identity", async ({ page }) => {
    const organization = await createOrganization(page.request);
    const groupName = "Browser capacity recovery";
    const groupResponse = await page.request.post(
      `/api/orgs/${organization.id}/messenger/groups`,
      { data: { name: groupName, icon: "folder::slate" } },
    );
    expect(groupResponse.ok(), await groupResponse.text()).toBe(true);
    await selectOrganization(page, organization.id);
    await installLocalAppsStub(page);
    await page.setViewportSize({ width: 1500, height: 920 });
    await page.goto(`/${organization.issuePrefix}/messenger`);

    await page.getByTestId("side-panel-hover-edge").hover();
    await page.getByTestId("global-side-panel-trigger").click({ force: true });
    await page.getByTestId("chat-side-panel-empty-browser-target").click();
    const savedUrl = "https://example.com/saved-at-capacity";
    const address = page.getByRole("textbox", { name: "Browser URL" });
    await address.fill(savedUrl);
    await address.press("Enter");
    const sourceGuest = page.getByTestId("chat-side-panel-browser-webview");
    await sourceGuest.evaluate((guest) => {
      guest.setAttribute("data-e2e-live-marker", "browser-guest-before-move");
    });
    const savedInstanceId = await page.locator(
      '[data-testid="chat-side-panel-tab"][aria-selected="true"]',
    ).getAttribute("data-view-instance-id");
    expect(savedInstanceId).toBeTruthy();

    await page.getByTestId("chat-side-panel-keep-in-messenger").click();
    await page.getByRole("menuitem", { name: groupName, exact: true }).click();
    await expect(page.getByText("Moved to Messenger")).toBeVisible();
    await expect(page).toHaveURL(/\/messenger\/saved\/[^/]+$/);
    await expect(sourceGuest).toHaveAttribute(
      "data-e2e-live-marker",
      "browser-guest-before-move",
    );

    const directory = await groups(page, organization.id);
    const savedItem = directory.groups.flatMap((candidate) => candidate.entries)
      .find((entry) => (
        entry.item.type === "saved_view"
        && entry.item.savedView.targetPayload.kind === "browser"
      ))?.item;
    if (!savedItem || savedItem.type !== "saved_view") {
      throw new Error("Expected kept Browser view");
    }
    const savedView = savedItem.savedView;
    expect(savedView.targetPayload.viewInstanceId).toBe(savedInstanceId);
    const savedCanonicalTabId = String(savedView.targetPayload.tabId);
    const main = page.getByTestId("messenger-main-workbench");
    const savedTab = main.locator(
      `[role="tab"][data-view-instance-id="${savedInstanceId}"]`,
    );
    await expect(savedTab).toBeVisible();

    for (let index = 0; index < 6; index += 1) {
      await main.getByRole("button", { name: "New Browser tab" }).click();
    }
    await expect(main.getByRole("tab")).toHaveCount(7);

    await page.getByTestId("global-side-panel-trigger").evaluate(
      (button: HTMLButtonElement) => button.click(),
    );
    await page.getByTestId("chat-side-panel-empty-browser-target").click();
    await expect(page.getByTestId("chat-side-panel-tab")).toHaveCount(1);
    await expect(main.getByRole("button", { name: "New Browser tab" }))
      .toBeDisabled();
    await expect(page.locator(
      "[data-testid='live-surface-runtime-host'][data-owner-id^='side:']",
    ).getByRole("button", { name: "Open new browser tab" })).toBeDisabled();

    await page.getByTestId("chat-side-panel-tab").hover();
    await page.getByTestId("chat-side-panel-tab-close").click();
    await expect(page.getByTestId("chat-side-panel-tab")).toHaveCount(0);
    await expect(main.getByRole("button", { name: "New Browser tab" }))
      .toBeEnabled();
    await main.getByRole("button", { name: "New Browser tab" }).click();
    await expect(main.getByRole("tab")).toHaveCount(8);

    await savedTab.locator("..").getByRole("button", {
      name: /Close .* tab/,
    }).click();
    await expect(main.getByRole("tab")).toHaveCount(7);
    await main.getByRole("button", { name: "New Browser tab" }).click();
    await expect(main.getByRole("tab")).toHaveCount(8);

    const savedRow = page.locator(
      `[data-messenger-saved-view-id="${savedView.id}"]`,
    );
    await expect(savedRow).not.toContainText(savedUrl);
    await savedRow.getByRole("link").click();
    await expect(page.getByTestId("messenger-saved-view-capacity-error"))
      .toContainText("Close a Browser tab");
    await expect(main.locator(
      `[role="tab"][data-view-instance-id="${savedInstanceId}"]`,
    )).toHaveCount(0);

    await closeActiveMainTab(page);
    await expect(page).toHaveURL(/\/messenger\/workbench$/);
    await savedRow.getByRole("link").click();
    await expect(main.locator(
      `[role="tab"][data-view-instance-id="${savedInstanceId}"][aria-selected="true"]`,
    )).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-browser-webview"))
      .toHaveAttribute("src", savedUrl);

    const navigatedUrl = "https://example.com/saved-at-capacity-navigated";
    const restoredBrowser = page.getByTestId("chat-side-panel-browser-view");
    const restoredAddress = restoredBrowser.getByRole(
      "textbox",
      { name: "Browser URL" },
    );
    await restoredAddress.fill(navigatedUrl);
    await restoredAddress.press("Enter");
    await expect(restoredBrowser.getByTestId("chat-side-panel-browser-webview"))
      .toHaveAttribute("src", navigatedUrl);
    await expect.poll(async () => {
      const refreshed = await groups(page, organization.id);
      const refreshedSaved = refreshed.groups
        .flatMap((candidate) => candidate.entries)
        .find((entry) => (
          entry.item.type === "saved_view"
          && entry.item.savedView.id === savedView.id
        ))?.item;
      return refreshedSaved?.type === "saved_view"
        ? {
            tabId: refreshedSaved.savedView.targetPayload.tabId,
            url: refreshedSaved.savedView.targetPayload.url,
          }
        : null;
    }).toEqual({ tabId: savedCanonicalTabId, url: navigatedUrl });
  });

  test("moves one running MKT instance and keeps lifecycle actions orthogonal", async ({ page }, testInfo) => {
    const organization = await createOrganization(page.request);
    const chat = await createChat(page, organization.id);
    await selectOrganization(page, organization.id);
    await installLocalAppsStub(page);
    await page.setViewportSize({ width: 1500, height: 920 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    await page.getByTestId("chat-side-panel-trigger").click();
    await page.getByTestId("chat-side-panel-empty-local-apps-target").click();
    const catalog = page.getByTestId("local-apps-catalog");
    await expect(catalog).toContainText(
      "never installs dependencies, builds, or runs migrations",
    );
    await page.getByTestId("local-apps-add").click();
    const review = page.getByTestId("local-app-definition-review");
    await expect(review.getByLabel("Working directory")).toHaveValue(
      "/Users/zeeland/projects/uranus/rudder/mkt/dashboard",
    );
    await review.getByLabel("Name", { exact: true }).fill("MKT dashboard local");
    await review.getByRole("button", { name: "Review & add" }).click();

    const card = page.getByTestId("local-apps-app-binding-a");
    await expect(card).toContainText("stopped");
    await page.getByTestId("local-apps-open-binding-a").click();
    const localView = page.getByTestId("local-app-view")
      .filter({ hasText: "MKT dashboard local" });
    expect((await calls(page)).start ?? 0).toBe(0);
    await localView.getByTestId("local-app-start").click();
    const sourceGuest = localView.getByTestId("local-app-webview");
    await expect(sourceGuest).toHaveAttribute(
      "src",
      "http://127.0.0.1:43123/outreach",
    );
    await expect(sourceGuest).toHaveAttribute(
      "partition",
      "persist:rudder-local-app-e2e",
    );
    await sourceGuest.evaluate((guest) => {
      guest.setAttribute("data-e2e-live-marker", "mkt-guest-before-move");
    });
    const movedInstanceId = await page.locator(
      '[data-testid="chat-side-panel-tab"][aria-selected="true"]',
    ).getAttribute("data-view-instance-id");
    expect(movedInstanceId).toBeTruthy();
    const startCallsBeforeMove = (await calls(page)).start;

    await page.getByTestId("chat-side-panel-keep-in-messenger").click();
    await expect(page.getByText("Moved to Messenger")).toBeVisible();
    await expect(page).toHaveURL(/\/messenger\/saved\/[^/]+$/);
    const main = page.getByTestId("messenger-main-workbench");
    const movedTab = main.locator(
      `[role="tab"][data-view-instance-id="${movedInstanceId}"][aria-selected="true"]`,
    );
    await expect(movedTab).toBeVisible();
    await expect(sourceGuest).toHaveAttribute(
      "data-e2e-live-marker",
      "mkt-guest-before-move",
    );
    expect((await calls(page)).start).toBe(startCallsBeforeMove);
    expect((await calls(page)).stop ?? 0).toBe(0);

    const directory = await groups(page, organization.id);
    const savedEntry = directory.groups.flatMap((group) => group.entries)
      .find((entry) => (
        entry.item.type === "saved_view"
        && entry.item.savedView.targetPayload.kind === "local_app"
      ))?.item;
    if (!savedEntry || savedEntry.type !== "saved_view") {
      throw new Error("Expected kept Local App");
    }
    expect(savedEntry.savedView.targetPayload).toEqual({
      kind: "local_app",
      desktopInstallationId: "installation-a",
      appPublicId: "public-a",
      localBindingId: "binding-a",
      viewInstanceId: movedInstanceId,
    });
    const serializedTarget = JSON.stringify(savedEntry.savedView.targetPayload);
    expect(serializedTarget).not.toContain("cwd");
    expect(serializedTarget).not.toContain("executable");
    expect(serializedTarget).not.toContain("environment");

    await main.getByRole("button", { name: "New Browser tab" }).click();
    await expect(main.getByRole("tab")).toHaveCount(2);
    expect((await calls(page)).stop ?? 0).toBe(0);
    await closeActiveMainTab(page);
    await movedTab.click();
    expect((await calls(page)).stop ?? 0).toBe(0);

    const savedRowContainer = page.locator(
      `[data-messenger-saved-view-id="${savedEntry.savedView.id}"]`,
    );
    const savedRow = savedRowContainer.getByRole("link");
    await main.getByRole("button", {
      name: "Close MKT dashboard local tab",
    }).click();
    await expect(savedRow).toBeVisible();
    expect((await calls(page)).stop ?? 0).toBe(0);
    await savedRow.click();
    await expect(main.locator(
      `[role="tab"][data-view-instance-id="${movedInstanceId}"][aria-selected="true"]`,
    )).toBeVisible();
    expect((await calls(page)).start).toBe(startCallsBeforeMove);

    await savedRowContainer.hover();
    await savedRowContainer.getByRole("button", {
      name: "Saved View actions for MKT dashboard local",
    }).click();
    await page.getByRole("menuitem", {
      name: "Remove from Messenger",
    }).click();
    await expect(page).toHaveURL(/\/messenger\/workbench$/);
    await expect(main.locator(
      `[role="tab"][data-view-instance-id="${movedInstanceId}"][aria-selected="true"]`,
    )).toBeVisible();
    await expect(savedRow).toHaveCount(0);
    expect((await calls(page)).stop ?? 0).toBe(0);

    const restoredView = page.getByTestId("local-app-view")
      .filter({ hasText: "MKT dashboard local" });
    await restoredView.getByTestId("local-app-stop").click();
    await expect(restoredView).toContainText("Stopped");
    expect((await calls(page)).stop).toBe(1);
    expect((await calls(page)).start).toBe(startCallsBeforeMove);

    await page.screenshot({
      path: testInfo.outputPath("messenger-main-mkt-local-app.png"),
      fullPage: true,
    });
  });
});
