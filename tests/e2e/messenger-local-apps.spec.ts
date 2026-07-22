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
    const readDefinitions = () => JSON.parse(window.localStorage.getItem(definitionsKey) ?? "[]");
    const writeDefinitions = (next: unknown) => window.localStorage.setItem(definitionsKey, JSON.stringify(next));
    const record = (name: string) => {
      const calls = JSON.parse(window.localStorage.getItem(callsKey) ?? "{}");
      calls[name] = (calls[name] ?? 0) + 1;
      window.localStorage.setItem(callsKey, JSON.stringify(calls));
    };
    const runtime = (status: string, generation: string | null = null, error?: string) => ({
      status,
      generation,
      ...(error ? { error } : {}),
    });
    const localApps = {
      supported: true,
      list: async () => {
        record("list");
        return readDefinitions();
      },
      discover: async () => {
        record("discover");
        const mode = window.localStorage.getItem("e2e.localApps.discoveryMode") ?? "success";
        if (mode === "cancel") return { canceled: true };
        if (mode === "error") throw new Error("Unsupported project folder");
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
        const current = readDefinitions().find((candidate: typeof definition) => candidate.id === id);
        const updated = { ...current, ...draft, id, updatedAt: "2026-07-23T01:00:00.000Z" };
        writeDefinitions([updated]);
        return updated;
      },
      delete: async () => {
        record("delete");
        if (JSON.parse(window.localStorage.getItem(statusKey) ?? "null")?.status === "running") {
          throw new Error("Cannot delete an active Local App");
        }
        writeDefinitions([]);
      },
      start: async () => {
        record("start");
        if (window.localStorage.getItem("e2e.localApps.startFailureOnce") === "true") {
          window.localStorage.setItem("e2e.localApps.startFailureOnce", "false");
          throw new Error("Readiness timed out");
        }
        const next = runtime("running", "generation-a");
        window.localStorage.setItem(statusKey, JSON.stringify(next));
        return next;
      },
      stop: async () => {
        record("stop");
        if (window.localStorage.getItem("e2e.localApps.stopFailureOnce") === "true") {
          window.localStorage.setItem("e2e.localApps.stopFailureOnce", "false");
          throw new Error("Stop bridge unavailable");
        }
        const next = runtime("stopped");
        window.localStorage.setItem(statusKey, JSON.stringify(next));
        return next;
      },
      status: async () => {
        record("status");
        if (window.localStorage.getItem("e2e.localApps.statusFailureOnce") === "true") {
          window.localStorage.setItem("e2e.localApps.statusFailureOnce", "false");
          throw new Error("Desktop bridge unavailable");
        }
        return JSON.parse(window.localStorage.getItem(statusKey) ?? "null") ?? runtime("stopped");
      },
      logs: async () => {
        record("logs");
        if (window.localStorage.getItem("e2e.localApps.logsFailureOnce") === "true") {
          window.localStorage.setItem("e2e.localApps.logsFailureOnce", "false");
          throw new Error("Logs bridge unavailable");
        }
        return ["MKT dashboard fixture log", "listener restricted to 127.0.0.1"];
      },
      attestedTarget: async () => {
        record("attestedTarget");
        const status = JSON.parse(window.localStorage.getItem(statusKey) ?? "null");
        return status?.status === "running" ? {
          origin: "http://127.0.0.1:43123",
          openPath: "/outreach",
          partition: "persist:rudder-local-app-e2e",
        } : null;
      },
    };
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        getBrowserPartition: async () => "persist:rudder-browser-v1-local-apps-e2e",
        localApps,
      },
    });
  });
}

async function setLocalFlag(page: Page, key: string, value: unknown) {
  await page.evaluate(([storageKey, storageValue]) => {
    window.localStorage.setItem(storageKey, typeof storageValue === "string"
      ? storageValue
      : JSON.stringify(storageValue));
  }, [key, value] as const);
}

async function calls(page: Page) {
  return page.evaluate(() => JSON.parse(window.localStorage.getItem("e2e.localApps.calls") ?? "{}") as Record<string, number>);
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

test.describe("Messenger Local Apps", () => {
  test("reports Browser capacity and restores with canonical identity after retry", async ({ page }) => {
    const organization = await createOrganization(page.request);
    const groupName = "Browser capacity recovery";
    const groupResponse = await page.request.post(`/api/orgs/${organization.id}/messenger/groups`, {
      data: { name: groupName, icon: "folder::slate" },
    });
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
    await page.getByTestId("chat-side-panel-keep-in-messenger").click();
    await page.getByRole("menuitem", { name: groupName, exact: true }).click();
    await expect(page.getByText("Kept in Messenger")).toBeVisible();

    const directory = await groups(page, organization.id);
    const savedItem = directory.groups.flatMap((candidate) => candidate.entries).find((entry) => (
      entry.item.type === "saved_view" && entry.item.savedView.targetPayload.kind === "browser"
    ))?.item;
    if (!savedItem || savedItem.type !== "saved_view") throw new Error("Expected kept Browser view");
    const savedView = savedItem.savedView;
    const savedInstanceId = String(savedView.targetPayload.viewInstanceId);
    const savedCanonicalTabId = String(savedView.targetPayload.tabId);

    for (let index = 0; index < 7; index += 1) {
      await page.getByTestId("chat-side-panel-add-tab").click();
      await page.getByTestId("chat-side-panel-empty-browser-target").click();
    }
    await expect(page.getByTestId("chat-side-panel-tab")).toHaveCount(8);
    const originalSavedTab = page.locator(
      `[data-testid="chat-side-panel-tab"][data-view-instance-id="${savedInstanceId}"]`,
    );
    await originalSavedTab.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close", exact: true }).click();
    await expect(page.getByTestId("chat-side-panel-tab")).toHaveCount(7);
    await page.getByTestId("chat-side-panel-add-tab").click();
    await page.getByTestId("chat-side-panel-empty-browser-target").click();
    await expect(page.getByTestId("chat-side-panel-tab")).toHaveCount(8);
    await expect(page.locator(
      `[data-testid="chat-side-panel-tab"][data-view-instance-id="${savedInstanceId}"]`,
    )).toHaveCount(0);

    await page.locator(`a[href$="/messenger/saved/${savedView.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/messenger/saved/${savedView.id}$`));
    const capacityError = page.getByTestId("messenger-saved-view-capacity-error");
    await expect(capacityError).toContainText("Close a Browser tab");
    await expect(page.getByTestId("messenger-saved-view-workspace")).toHaveCount(0);
    await expect(page.getByTestId("chat-side-panel-tab")).toHaveCount(8);
    await expect(page.locator(
      `[data-testid="chat-side-panel-tab"][data-view-instance-id="${savedInstanceId}"]`,
    )).toHaveCount(0);

    const selectedTab = page.locator('[data-testid="chat-side-panel-tab"][aria-selected="true"]');
    await selectedTab.locator("..").getByTestId("chat-side-panel-tab-close").click({ force: true });
    await expect(page.getByTestId("chat-side-panel-tab")).toHaveCount(7);
    await capacityError.getByRole("button", { name: "Retry opening" }).click();
    await expect(page.getByTestId("messenger-saved-view-workspace")).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-tab")).toHaveCount(8);
    await expect(page.locator(
      `[data-testid="chat-side-panel-tab"][data-view-instance-id="${savedInstanceId}"][aria-selected="true"]`,
    )).toBeVisible();
    await expect(page.locator('[data-testid="chat-side-panel-browser-webview"][data-active="true"]'))
      .toHaveAttribute("src", savedUrl);

    const navigatedUrl = "https://example.com/saved-at-capacity-navigated";
    const restoredBrowser = page.getByTestId("chat-side-panel-browser-view");
    await restoredBrowser.getByRole("textbox", { name: "Browser URL" }).fill(navigatedUrl);
    await restoredBrowser.getByRole("textbox", { name: "Browser URL" }).press("Enter");
    await expect(restoredBrowser.getByTestId("chat-side-panel-browser-webview"))
      .toHaveAttribute("src", navigatedUrl);
    await expect.poll(async () => {
      const refreshed = await groups(page, organization.id);
      const refreshedSaved = refreshed.groups.flatMap((candidate) => candidate.entries).find((entry) => (
        entry.item.type === "saved_view" && entry.item.savedView.id === savedView.id
      ))?.item;
      return refreshedSaved?.type === "saved_view"
        ? {
          tabId: refreshedSaved.savedView.targetPayload.tabId,
          url: refreshedSaved.savedView.targetPayload.url,
        }
        : null;
    }).toEqual({ tabId: savedCanonicalTabId, url: navigatedUrl });
  });

  test("discovers, reviews, runs, keeps, restores, and safely controls a local dashboard", async ({ page }) => {
    const organization = await createOrganization(page.request);
    const chat = await createChat(page, organization.id);
    await selectOrganization(page, organization.id);
    await installLocalAppsStub(page);
    await page.setViewportSize({ width: 1500, height: 920 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    await page.getByTestId("chat-side-panel-trigger").click();
    await page.getByTestId("chat-side-panel-empty-local-apps-target").click();
    const catalog = page.getByTestId("local-apps-catalog");
    await expect(catalog).toBeVisible();
    await expect(catalog).toContainText("never installs dependencies, builds, or runs migrations");

    await setLocalFlag(page, "e2e.localApps.discoveryMode", "cancel");
    await page.getByTestId("local-apps-add").click();
    await expect(page.getByTestId("local-app-definition-review")).toHaveCount(0);

    await setLocalFlag(page, "e2e.localApps.discoveryMode", "error");
    await page.getByTestId("local-apps-add").click();
    await expect(page.getByTestId("local-app-error")).toContainText("Unsupported project folder");
    await setLocalFlag(page, "e2e.localApps.discoveryMode", "success");
    await page.getByRole("button", { name: "Retry", exact: true }).click();

    const review = page.getByTestId("local-app-definition-review");
    await expect(review).toBeVisible();
    await expect(review.getByLabel("Working directory")).toHaveValue("/Users/zeeland/projects/uranus/rudder/mkt/dashboard");
    await expect(review).toContainText("can modify local files and data");
    await review.getByLabel("Name", { exact: true }).fill("MKT dashboard local");
    await setLocalFlag(page, "e2e.localApps.statusFailureOnce", "true");
    await review.getByRole("button", { name: "Review & add" }).click();

    const card = page.getByTestId("local-apps-app-binding-a");
    await expect(card).toContainText("MKT dashboard local");
    await expect(card.getByRole("alert")).toContainText("Desktop bridge unavailable");
    await expect(card.getByRole("button", { name: "Edit" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Delete" })).toBeDisabled();
    await card.getByRole("button", { name: "Retry status" }).click();
    await expect(card).toContainText("stopped");
    await expect(card.getByRole("button", { name: "Edit" })).toBeEnabled();
    await expect(card.getByRole("button", { name: "Delete" })).toBeEnabled();

    await setLocalFlag(page, "e2e.localApps.logsFailureOnce", "true");
    await card.getByRole("button", { name: "Logs" }).click();
    await expect(card.getByRole("alert")).toContainText("Logs bridge unavailable");
    await expect(card).not.toContainText("No runtime logs yet.");
    await card.getByRole("button", { name: "Retry logs" }).click();
    await expect(card.getByTestId("local-app-logs")).toContainText("listener restricted to 127.0.0.1");
    await page.screenshot({ path: "/tmp/rudder-local-apps-catalog.png", fullPage: true });
    expect((await calls(page)).create).toBe(1);

    await page.getByTestId("local-apps-open-binding-a").click();
    const localView = page.getByTestId("local-app-view").filter({ hasText: "MKT dashboard local" });
    await expect(localView).toContainText("Stopped");
    expect((await calls(page)).start ?? 0).toBe(0);
    await localView.getByRole("button", { name: "Show logs" }).click();
    await expect(localView.getByTestId("local-app-logs")).toContainText("listener restricted to 127.0.0.1");

    await setLocalFlag(page, "e2e.localApps.startFailureOnce", "true");
    await localView.getByTestId("local-app-start").click();
    await expect(localView.getByTestId("local-app-error")).toContainText("Readiness timed out");
    await expect(localView.getByTestId("local-app-logs")).toContainText("MKT dashboard fixture log");
    await localView.getByTestId("local-app-start").click();
    const guest = localView.getByTestId("local-app-webview");
    await expect(guest).toHaveAttribute("src", "http://127.0.0.1:43123/outreach");
    await expect(guest).toHaveAttribute("partition", "persist:rudder-local-app-e2e");
    await expect(guest).toHaveAttribute("data-local-binding-id", "binding-a");
    await expect(guest).toHaveAttribute("data-active", "true");
    await expect(guest).not.toHaveAttribute("allowpopups", /.+/);

    const attestedCallsBeforeExternalExit = (await calls(page)).attestedTarget;
    await setLocalFlag(page, "e2e.localApps.status", {
      status: "failed",
      generation: null,
      error: "Process exited unexpectedly",
    });
    await expect(localView).toContainText("Failed", { timeout: 5_000 });
    await expect(localView).toContainText("Process exited unexpectedly");
    await expect(localView.getByTestId("local-app-webview")).toHaveCount(0);
    await expect(localView.getByTestId("local-app-start")).toContainText("Retry & open");

    await localView.getByTestId("local-app-start").click();
    await expect(localView.getByTestId("local-app-webview"))
      .toHaveAttribute("src", "http://127.0.0.1:43123/outreach");
    await expect.poll(async () => (await calls(page)).attestedTarget)
      .toBe(attestedCallsBeforeExternalExit + 1);
    const startCallsAfterExternalRecovery = (await calls(page)).start;
    await page.screenshot({ path: "/tmp/rudder-local-app-running.png", fullPage: true });

    await page.getByTestId("chat-side-panel-keep-in-messenger").click();
    await expect(page.getByText("Kept in Messenger")).toBeVisible();
    const directory = await groups(page, organization.id);
    const savedEntry = directory.groups.flatMap((group) => group.entries)
      .find((entry) => entry.item.type === "saved_view")?.item;
    expect(savedEntry?.type).toBe("saved_view");
    if (!savedEntry || savedEntry.type !== "saved_view") throw new Error("Expected kept Local App");
    const savedGroup = directory.groups.find((candidate) => candidate.entries.some(
      (entry) => entry.item.type === "saved_view" && entry.item.savedView.id === savedEntry.savedView.id,
    ));
    expect(savedGroup).toBeTruthy();
    expect(savedGroup!.entries.some((entry) => entry.itemKey === `chat:${chat.id}`)).toBe(true);
    expect(savedGroup!.entries.some((entry) => (
      entry.itemKey === `saved-view:${savedEntry.savedView.id}`
      && entry.item.type === "saved_view"
      && entry.item.savedView.id === savedEntry.savedView.id
    ))).toBe(true);
    expect(savedEntry.savedView.targetPayload).toEqual({
      kind: "local_app",
      desktopInstallationId: "installation-a",
      appPublicId: "public-a",
      localBindingId: "binding-a",
      viewInstanceId: expect.any(String),
    });
    expect(JSON.stringify(savedEntry.savedView.targetPayload)).not.toContain("cwd");
    expect(JSON.stringify(savedEntry.savedView.targetPayload)).not.toContain("executable");
    expect(JSON.stringify(savedEntry.savedView.targetPayload)).not.toContain("environment");

    const activeTab = page.getByTestId("chat-side-panel-tab").filter({ hasText: "MKT dashboard local" }).last();
    await activeTab.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open in new tab" }).click();
    await expect(page.getByTestId("local-app-view")).toHaveCount(2);
    await expect(page.getByTestId("local-app-webview")).toHaveCount(2);
    expect((await calls(page)).start).toBe(startCallsAfterExternalRecovery);

    await page.getByTestId("chat-side-panel-tab").filter({ hasText: "MKT dashboard local" }).last().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close", exact: true }).click();
    await expect(page.getByTestId("local-app-view")).toHaveCount(1);
    expect((await calls(page)).stop ?? 0).toBe(0);

    await page.getByTestId("chat-side-panel-add-tab").click();
    await page.getByTestId("chat-side-panel-empty-local-apps-target").click();
    const activeCard = page.getByTestId("local-apps-app-binding-a");
    await expect(activeCard).toContainText("Stop this Local App before editing or deleting it.");
    await expect(activeCard.getByRole("button", { name: "Edit" })).toBeDisabled();
    await expect(activeCard.getByRole("button", { name: "Delete" })).toBeDisabled();
    await setLocalFlag(page, "e2e.localApps.stopFailureOnce", "true");
    await activeCard.getByRole("button", { name: "Stop" }).click();
    await expect(activeCard.getByRole("alert")).toContainText("Stop bridge unavailable");
    await activeCard.getByRole("button", { name: "Retry stop" }).click();
    await expect(activeCard).toContainText("stopped");
    expect((await calls(page)).stop).toBe(2);

    await activeCard.getByRole("button", { name: "Edit" }).click();
    const editReview = page.getByTestId("local-app-definition-review");
    await editReview.getByLabel("Name", { exact: true }).fill("MKT dashboard reviewed");
    await editReview.getByRole("button", { name: "Review & save" }).click();
    await expect(activeCard).toContainText("MKT dashboard reviewed");
    expect((await calls(page)).update).toBe(1);

    await page.getByTestId("chat-side-panel-add-tab").click();
    await page.getByTestId("chat-side-panel-empty-browser-target").click();
    const browserView = page.getByTestId("chat-side-panel-browser-view");
    const browserAddress = browserView.getByRole("textbox", { name: "Browser URL" });
    const browserInitialUrl = "https://example.com/messenger-local-app";
    await browserAddress.fill(browserInitialUrl);
    await browserAddress.press("Enter");
    await expect(browserView.getByTestId("chat-side-panel-browser-webview")).toHaveAttribute("src", browserInitialUrl);
    await page.getByTestId("chat-side-panel-keep-in-messenger").click();
    await expect(page.getByText("Kept in Messenger")).toBeVisible();
    await expect.poll(async () => {
      const next = await groups(page, organization.id);
      return next.groups.flatMap((candidate) => candidate.entries).some((candidate) => (
        candidate.item.type === "saved_view"
        && candidate.item.savedView.targetPayload.kind === "browser"
      ));
    }).toBe(true);
    const browserDirectory = await groups(page, organization.id);
    const browserSavedItem = browserDirectory.groups.flatMap((candidate) => candidate.entries).find((candidate) => (
      candidate.item.type === "saved_view"
      && candidate.item.savedView.targetPayload.kind === "browser"
    ))?.item;
    if (!browserSavedItem || browserSavedItem.type !== "saved_view") throw new Error("Expected kept Browser view");
    const browserSavedEntry = browserSavedItem.savedView;
    let browserMetadataUpdateCount = 0;
    page.on("request", (request) => {
      if (
        request.method() === "PATCH"
        && new URL(request.url()).pathname === `/api/orgs/${organization.id}/messenger/saved-views/${browserSavedEntry.id}`
      ) browserMetadataUpdateCount += 1;
    });
    const browserSavedGroup = (await groups(page, organization.id)).groups.find((candidate) => candidate.entries.some(
      (entry) => entry.item.type === "saved_view" && entry.item.savedView.id === browserSavedEntry.id,
    ));
    expect(browserSavedGroup).toBeTruthy();
    const browserGroupSection = page.getByTestId(`messenger-thread-section-custom-group-${browserSavedGroup!.id}`);
    const browserSavedRow = browserGroupSection.locator(`a[href$="/messenger/saved/${browserSavedEntry.id}"]`).locator("..");
    await browserSavedRow.hover();
    await browserSavedRow.getByRole("button", { name: `Saved View actions for ${browserSavedEntry.title}` }).click();
    const removeBrowserSavedView = page.getByRole("menuitem", { name: "Remove from Messenger" });
    await expect(removeBrowserSavedView).toBeVisible();
    let releaseGroupsRefetch!: () => void;
    let markGroupsRefetchStarted!: () => void;
    const groupsRefetchRelease = new Promise<void>((resolve) => { releaseGroupsRefetch = resolve; });
    const groupsRefetchStarted = new Promise<void>((resolve) => { markGroupsRefetchStarted = resolve; });
    let holdGroupsRefetch = true;
    await page.route(`**/api/orgs/${organization.id}/messenger/groups`, async (route) => {
      if (route.request().method() !== "GET" || !holdGroupsRefetch) {
        await route.continue();
        return;
      }
      markGroupsRefetchStarted();
      await groupsRefetchRelease;
      await route.continue();
    });
    const browserQueuedUrl = "https://example.com/deleted-before-metadata-sync";
    const updatesBeforeBrowserDelete = browserMetadataUpdateCount;
    await browserView.locator('input[aria-label="Browser URL"]').evaluate((element, nextUrl) => {
      const input = element as HTMLInputElement;
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input, nextUrl);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.form?.requestSubmit();
    }, browserQueuedUrl);
    await removeBrowserSavedView.click();
    await expect.poll(async () => {
      const next = await groups(page, organization.id);
      return next.groups.flatMap((candidate) => candidate.entries).some(
        (entry) => entry.item.type === "saved_view" && entry.item.savedView.id === browserSavedEntry.id,
      );
    }).toBe(false);
    await expect(browserView.getByTestId("chat-side-panel-browser-webview")).toHaveAttribute("src", browserQueuedUrl);
    await groupsRefetchStarted;
    await page.waitForTimeout(1_200);
    expect(browserMetadataUpdateCount).toBe(updatesBeforeBrowserDelete);
    holdGroupsRefetch = false;
    releaseGroupsRefetch();
    await page.waitForTimeout(800);
    expect(browserMetadataUpdateCount).toBe(updatesBeforeBrowserDelete);
    await page.unroute(`**/api/orgs/${organization.id}/messenger/groups`);

    const startCountBeforeRestore = (await calls(page)).start;
    await page.goto(`/${organization.issuePrefix}/messenger/saved/${savedEntry.savedView.id}`);
    await expect(page.getByTestId("messenger-saved-view-workspace")).toContainText("MKT dashboard local");
    await expect(page.getByTestId("local-app-start")).toBeVisible();
    expect((await calls(page)).start).toBe(startCountBeforeRestore);
    await page.reload();
    await expect(page.getByTestId("local-app-start")).toBeVisible();
    expect((await calls(page)).start).toBe(startCountBeforeRestore);

    await setLocalFlag(page, "e2e.localApps.statusFailureOnce", "true");
    await page.reload();
    const savedError = page.getByTestId("messenger-saved-view-error");
    await expect(savedError).toContainText("Desktop bridge unavailable");
    await savedError.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("messenger-saved-view-workspace")).toBeVisible();
    expect((await calls(page)).start).toBe(startCountBeforeRestore);

    const currentDefinitions = await page.evaluate(() => window.localStorage.getItem("e2e.localApps.definitions"));
    const otherDeviceDefinitions = JSON.parse(currentDefinitions ?? "[]").map((candidate: Record<string, unknown>) => ({
      ...candidate,
      desktopInstallationId: "installation-other",
    }));
    await setLocalFlag(page, "e2e.localApps.definitions", otherDeviceDefinitions);
    const statusCallsBeforeUnavailable = (await calls(page)).status;
    await page.reload();
    await expect(page.getByTestId("messenger-saved-view-unavailable")).toContainText("not available on this device");
    expect((await calls(page)).status).toBe(statusCallsBeforeUnavailable);
    expect((await calls(page)).start).toBe(startCountBeforeRestore);

    await setLocalFlag(page, "e2e.localApps.definitions", JSON.parse(currentDefinitions ?? "[]"));
    await setLocalFlag(page, "e2e.localApps.status", { status: "orphaned_unverified", generation: "generation-a" });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
    await page.getByTestId("chat-side-panel-trigger").click();
    await page.getByTestId("chat-side-panel-empty-local-apps-target").click();
    const orphanedCard = page.getByTestId("local-apps-app-binding-a");
    await expect(orphanedCard).toContainText("Ownership is unverified");
    await expect(orphanedCard.getByRole("button", { name: "Edit" })).toBeDisabled();
    await expect(orphanedCard.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect((await calls(page)).start).toBe(startCountBeforeRestore);

    await page.goto(`/${organization.issuePrefix}/messenger`);
    for (const organizationLabel of ["Agent", "Thread type", "Needs attention"]) {
      await page.getByTestId("messenger-thread-organization-trigger").click();
      await page.getByRole("menuitemradio", { name: organizationLabel, exact: true }).click();
      const organizedGroup = page.getByTestId(`messenger-thread-section-custom-group-${savedGroup!.id}`);
      const organizedSavedRow = organizedGroup
        .locator('[data-testid^="messenger-saved-view-"]')
        .filter({ hasText: "MKT dashboard local" });
      await expect(organizedGroup).toBeVisible();
      await expect(organizedSavedRow).toHaveCount(1);
      await expect(organizedGroup.locator('[data-testid$="-attention-count"]')).toHaveCount(0);

      await page.reload();
      const restoredGroup = page.getByTestId(`messenger-thread-section-custom-group-${savedGroup!.id}`);
      await expect(restoredGroup).toBeVisible();
      await expect(restoredGroup
        .locator('[data-testid^="messenger-saved-view-"]')
        .filter({ hasText: "MKT dashboard local" })).toHaveCount(1);
    }
    await page.getByTestId("messenger-thread-organization-trigger").click();
    await page.getByRole("menuitemradio", { name: "Latest activity", exact: true }).click();
    const group = page.getByTestId(`messenger-thread-section-custom-group-${savedGroup!.id}`);
    const row = group.locator('[data-testid^="messenger-saved-view-"]').filter({ hasText: "MKT dashboard local" });
    await row.hover();
    await row.getByRole("button", { name: "Saved View actions for MKT dashboard local" }).click();
    const stopCountBeforeSavedRemove = (await calls(page)).stop;
    await page.getByRole("menuitem", { name: "Remove from Messenger" }).click();
    await expect.poll(async () => {
      const next = await groups(page, organization.id);
      return next.groups.flatMap((candidate) => candidate.entries)
        .some((entry) => entry.item.type === "saved_view" && entry.item.savedView.id === savedEntry.savedView.id);
    }).toBe(false);
    expect((await calls(page)).stop).toBe(stopCountBeforeSavedRemove);

    await setLocalFlag(page, "e2e.localApps.status", { status: "stopped", generation: null });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
    await page.getByTestId("chat-side-panel-trigger").click();
    await page.getByTestId("chat-side-panel-empty-local-apps-target").click();
    const deletableCard = page.getByTestId("local-apps-app-binding-a");
    await expect(deletableCard).toContainText("stopped");
    await deletableCard.getByRole("button", { name: "Delete" }).click();
    const deleteDialog = page.getByRole("dialog", { name: "Delete Local App?" });
    await deleteDialog.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByTestId("local-apps-app-binding-a")).toHaveCount(0);
    expect((await calls(page)).delete).toBe(1);
    expect((await calls(page)).stop).toBe(stopCountBeforeSavedRemove);
    expect((await calls(page)).start).toBe(startCountBeforeRestore);
  });
});
