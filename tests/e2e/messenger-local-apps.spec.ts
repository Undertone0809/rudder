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

async function setExperimentalSitesEnabled(request: APIRequestContext, enabled: boolean) {
  const response = await request.patch("/api/instance/settings/general", {
    data: { experimentalSitesEnabled: enabled },
  });
  expect(response.ok(), await response.text()).toBe(true);
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
      iconDataUrl: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iIzBmOGE2MyIvPjxwYXRoIGQ9Ik03IDIzVjloNGw1IDcgNS03aDR2MTRoLTR2LThsLTUgNi01LTZ2OHoiIGZpbGw9IndoaXRlIi8+PC9zdmc+",
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
            const failure = window.localStorage.getItem("e2e.localApps.startFailure");
            if (failure) throw new Error(failure);
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

async function seedLocalAppBinding(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("e2e.localApps.definitions", JSON.stringify([{
      id: "definition-a",
      desktopInstallationId: "installation-a",
      appPublicId: "public-a",
      localBindingId: "binding-a",
      title: "MKT dashboard",
      executable: "/opt/homebrew/bin/npm",
      argv: ["run", "dev"],
      cwd: "/Users/zeeland/projects/uranus/rudder/mkt/dashboard",
      inheritedEnvNames: [],
      readiness: { path: "/api/health", timeoutMs: 30_000 },
      openPath: "/outreach",
      trustFingerprint: "fingerprint-a",
      approvedFingerprint: "fingerprint-a",
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    }]));
    window.localStorage.setItem(
      "e2e.localApps.status",
      JSON.stringify({ status: "stopped", generation: null }),
    );
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
  test("opens a pinned stopped Local App as a restorable top-level workspace", async ({ page }) => {
    const organization = await createOrganization(page.request);
    await setExperimentalSitesEnabled(page.request, true);
    await selectOrganization(page, organization.id);
    await installLocalAppsStub(page);
    await seedLocalAppBinding(page);
    const keepResponse = await page.request.post(
      `/api/orgs/${organization.id}/messenger/saved-views/keep`,
      {
        data: {
          title: "MKT dashboard",
          target: {
            kind: "local_app",
            desktopInstallationId: "installation-a",
            appPublicId: "public-a",
            localBindingId: "binding-a",
            viewInstanceId: "pinned-local-view-a",
          },
          clientMutationId: randomUUID(),
          placement: { kind: "loose" },
        },
      },
    );
    expect(keepResponse.ok(), await keepResponse.text()).toBe(true);
    const kept = await keepResponse.json() as { savedView: { id: string } };
    const pinResponse = await page.request.patch(
      `/api/orgs/${organization.id}/messenger/saved-views/${kept.savedView.id}`,
      { data: { primaryRailPinned: true } },
    );
    expect(pinResponse.ok(), await pinResponse.text()).toBe(true);

    await page.setViewportSize({ width: 1500, height: 920 });
    await page.goto(
      `/${organization.issuePrefix}/apps/saved/${kept.savedView.id}`,
    );

    const rail = page.getByTestId("primary-rail");
    const pin = rail.getByRole("link", { name: "MKT dashboard", exact: true });
    await expect(pin).toHaveAttribute("aria-current", "page");
    await expect(rail.getByRole("link", { name: "Apps", exact: true }))
      .not.toHaveAttribute("aria-current", "page");
    await expect(rail.getByTestId("primary-rail-active-indicator")).toBeVisible();
    await expect(rail.getByTestId("primary-rail-pinned-active-indicator")).toHaveCount(0);
    await expect(page.getByTestId("workspace-context-card")).toHaveCount(0);
    const workbench = page.getByTestId("messenger-main-workbench");
    await expect(workbench).toBeVisible();
    const localView = page.getByTestId("local-app-view").filter({ hasText: "MKT dashboard" });
    await expect(localView.getByTestId("local-app-start")).toContainText("Start & open");
    expect((await calls(page)).start ?? 0).toBe(0);

    await page.reload();
    await expect(page).toHaveURL(
      new RegExp(`/${organization.issuePrefix}/apps/saved/${kept.savedView.id}$`, "i"),
    );
    await expect(page.getByTestId("workspace-context-card")).toHaveCount(0);
    await expect(page.getByTestId("local-app-view").getByTestId("local-app-start"))
      .toContainText("Start & open");
    expect((await calls(page)).start ?? 0).toBe(0);

    await page.goto(
      `/${organization.issuePrefix}/messenger/saved/${kept.savedView.id}`,
    );
    await expect(page.getByTestId("workspace-context-card")).toBeVisible();
    await expect(page.getByTestId("messenger-main-workbench")).toBeVisible();
    expect((await calls(page)).start ?? 0).toBe(0);
  });

  test("prepares a redacted AI recovery draft until the operator explicitly sends it", async ({ page }) => {
    const organization = await createOrganization(page.request);
    const chat = await createChat(page, organization.id);
    const failure = "Readiness timed out at /Users/private/marketing with API_KEY=not-for-chat on 127.0.0.1:43123";
    await setExperimentalSitesEnabled(page.request, true);
    await selectOrganization(page, organization.id);
    await installLocalAppsStub(page);
    await page.setViewportSize({ width: 1500, height: 920 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder:chat-drafts", JSON.stringify({
        [orgId]: {
          __new__: {
            version: 1,
            body: "Keep this unrelated new Chat draft.",
            inlineAnnotations: [],
          },
        },
      }));
    }, organization.id);

    await page.getByTestId("chat-side-panel-trigger").click();
    await page.getByTestId("chat-side-panel-empty-local-apps-target").click();
    await page.getByTestId("local-apps-add").click();
    await page.getByTestId("local-app-definition-review")
      .getByRole("button", { name: "Review & add" }).click();
    await page.getByTestId("local-apps-open-binding-a").click();
    const localView = page.getByTestId("local-app-view")
      .filter({ hasText: "MKT dashboard" });
    await page.evaluate((nextFailure) => {
      window.localStorage.setItem("e2e.localApps.startFailure", nextFailure);
    }, failure);
    const chatsBefore = await (await page.request.get(
      `/api/orgs/${organization.id}/chats?status=all`,
    )).json() as Array<{ id: string }>;

    await localView.getByTestId("local-app-start").click();
    await expect(localView.getByTestId("local-app-error")).toContainText("Readiness timed out");
    await expect(localView.getByTestId("local-app-ask-ai")).toBeVisible();
    const callsBeforeHelp = await calls(page);

    await localView.getByTestId("local-app-ask-ai").click();
    await expect(page).toHaveURL(
      /\/messenger\/chat(?:\?.*)?$/,
    );
    const recoveryDraftId = new URL(page.url()).searchParams.get("localAppRecoveryDraft");
    expect(recoveryDraftId).toMatch(
      /^[0-9a-f-]{36}$/i,
    );
    const composer = page.getByTestId("chat-composer-editor-scroll")
      .locator("[contenteditable='true']").first();
    await expect(composer).toContainText("A Local App could not open in Rudder Desktop.");
    await expect(composer).toContainText("MKT dashboard");
    const prompt = await composer.innerText();
    expect(prompt).not.toContain(failure);
    expect(prompt).not.toContain("/Users/private/marketing");
    expect(prompt).not.toContain("API_KEY");
    expect(prompt).not.toContain("127.0.0.1:43123");
    const preservedRootDraft = await page.evaluate((orgId) => {
      const drafts = JSON.parse(window.localStorage.getItem("rudder:chat-drafts") ?? "{}");
      return drafts[orgId]?.__new__?.body ?? "";
    }, organization.id);
    expect(preservedRootDraft).toBe("Keep this unrelated new Chat draft.");
    expect((await calls(page)).start ?? 0).toBe(callsBeforeHelp.start ?? 0);
    expect((await calls(page)).logs ?? 0).toBe(callsBeforeHelp.logs ?? 0);
    const chatsAfter = await (await page.request.get(
      `/api/orgs/${organization.id}/chats?status=all`,
    )).json() as Array<{ id: string }>;
    expect(chatsAfter.map(({ id }) => id)).toEqual(chatsBefore.map(({ id }) => id));

    await page.getByRole("button", { name: "Send" }).click();
    await expect(page).toHaveURL(/\/messenger\/chat\/[^/?]+$/);
    await expect.poll(() => page.evaluate(({ orgId, recoveryId }) => {
      const drafts = JSON.parse(window.localStorage.getItem("rudder:chat-drafts") ?? "{}");
      return drafts[orgId]?.[`local-app-recovery:${recoveryId}`] ?? null;
    }, { orgId: organization.id, recoveryId: recoveryDraftId })).toBeNull();
  });

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
    const reviewScroll = review.getByTestId("local-app-definition-review-scroll");
    await expect(review).toHaveClass(/overflow-hidden/);
    await expect(reviewScroll).toHaveClass(/scrollbar-auto-hide/);
    await expect(reviewScroll).toHaveCSS("overflow-y", "auto");
    await expect(review.getByRole("button", { name: "Review & add" })).toBeVisible();
    await expect(review.getByTestId("local-app-start-command")).toHaveText("npm run dev");
    await review.getByTestId("local-app-advanced-toggle").click();
    await reviewScroll.evaluate((element) => element.dispatchEvent(new Event("scroll")));
    await expect(reviewScroll).toHaveClass(/is-scrolling/);
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
    await expect(main).toHaveClass(/messenger-main-workbench-surface/);
    const mainSurface = await main.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundImage: style.backgroundImage,
        borderRadius: style.borderRadius,
      };
    });
    expect(mainSurface.backgroundImage).not.toBe("none");
    expect(mainSurface.borderRadius).not.toBe("0px");
    await expect(main.getByRole("button", {
      name: "Reorder MKT dashboard local tab",
    })).toHaveCount(0);
    await expect(sourceGuest).toHaveAttribute(
      "data-e2e-live-marker",
      "mkt-guest-before-move",
    );
    expect((await calls(page)).start).toBe(startCallsBeforeMove);
    expect((await calls(page)).stop ?? 0).toBe(0);

    await movedTab.hover();
    await main.getByRole("button", {
      name: "More options for MKT dashboard local",
    }).click();
    await page.getByRole("menuitem", { name: "Project settings" }).click();
    const runningSettings = page.getByTestId("local-app-definition-review");
    await runningSettings.getByTestId("local-app-advanced-toggle").click();
    await expect(runningSettings.getByLabel("Name", { exact: true })).toBeDisabled();
    await expect(runningSettings).toContainText(
      "Stop this Local App to edit its launch settings.",
    );
    await runningSettings.getByRole("button", { name: "Cancel" }).click();
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

    const liveLocalApp = page.getByTestId("local-app-view")
      .filter({ hasText: "MKT dashboard local" });
    await liveLocalApp.getByTestId("local-app-more").click();
    await page.getByRole("menuitem", { name: "Pin to Primary Rail" }).click();
    const primaryRailPin = page.getByTestId("primary-rail")
      .getByRole("link", { name: "MKT dashboard local" });
    await expect(primaryRailPin).toBeVisible();
    await expect(primaryRailPin.getByTestId("primary-rail-local-app-icon")).toBeVisible();
    await liveLocalApp.getByTestId("local-app-more").click();
    await expect(page.getByRole("menuitem", { name: "Edit details" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Unpin from Primary Rail" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Stop" })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("local-app-more-menu-and-primary-rail-pin.png"),
      fullPage: true,
    });
    if (process.env.RUDDER_E2E_VISUAL_PROOF_PATH) {
      await page.screenshot({
        path: process.env.RUDDER_E2E_VISUAL_PROOF_PATH,
        fullPage: true,
      });
    }
    await page.keyboard.press("Escape");

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
    await primaryRailPin.click();
    await expect(page).toHaveURL(
      new RegExp(`/apps/saved/${savedEntry.savedView.id}$`),
    );
    await expect(primaryRailPin).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("workspace-context-card")).toHaveCount(0);
    await expect(main.locator(
      `[role="tab"][data-view-instance-id="${movedInstanceId}"][aria-selected="true"]`,
    )).toBeVisible();
    expect((await calls(page)).start).toBe(startCallsBeforeMove);

    await page.goto(
      `/${organization.issuePrefix}/messenger/saved/${savedEntry.savedView.id}`,
    );
    await expect(page).toHaveURL(
      new RegExp(`/messenger/saved/${savedEntry.savedView.id}$`),
    );
    await expect(page.getByTestId("workspace-context-card")).toBeVisible();

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
    await expect(primaryRailPin).toHaveCount(0);
    expect((await calls(page)).stop ?? 0).toBe(0);

    const restoredView = page.getByTestId("local-app-view")
      .filter({ hasText: "MKT dashboard local" });
    await restoredView.getByTestId("local-app-more").click();
    await page.getByRole("menuitem", { name: "Stop" }).click();
    await expect(restoredView).toContainText("Stopped");
    expect((await calls(page)).stop).toBe(1);
    expect((await calls(page)).start).toBe(startCallsBeforeMove);

    const sessionTab = main.locator(
      `[role="tab"][data-view-instance-id="${movedInstanceId}"]`,
    );
    await sessionTab.hover();
    await main.getByRole("button", {
      name: "More options for MKT dashboard local",
    }).click();
    await page.getByRole("menuitem", { name: "Project settings" }).click();
    const editableSettings = page.getByTestId("local-app-definition-review");
    await editableSettings.getByTestId("local-app-advanced-toggle").click();
    await editableSettings.getByLabel("Name", { exact: true })
      .fill("MKT command center");
    await editableSettings.getByLabel("Page to open after readiness")
      .fill("/overview");
    await editableSettings.getByRole("button", { name: "Review & save" }).click();
    await expect(main.getByRole("tab", { name: /MKT command center/ })).toBeVisible();
    expect((await calls(page)).update).toBe(1);

    await page.screenshot({
      path: testInfo.outputPath("messenger-main-mkt-local-app.png"),
      fullPage: true,
    });
  });

  test("keeps Local App details scrollable inside the modal on a narrow viewport", async ({ page }) => {
    const organization = await createOrganization(page.request);
    const chat = await createChat(page, organization.id);
    await selectOrganization(page, organization.id);
    await installLocalAppsStub(page);
    await page.setViewportSize({ width: 460, height: 820 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    await page.getByTestId("chat-side-panel-trigger").click();
    await page.getByTestId("chat-side-panel-empty-local-apps-target").click();
    await page.getByTestId("local-apps-add").click();

    const review = page.getByTestId("local-app-definition-review");
    const reviewScroll = review.getByTestId("local-app-definition-review-scroll");
    const geometry = await reviewScroll.evaluate((element) => {
      const dialog = element.closest("[data-testid='local-app-definition-review']");
      if (!dialog) throw new Error("Expected Local App review dialog");
      const dialogRect = dialog.getBoundingClientRect();
      const scrollRect = element.getBoundingClientRect();
      return {
        dialog: { left: dialogRect.left, right: dialogRect.right, top: dialogRect.top, bottom: dialogRect.bottom },
        scroll: { left: scrollRect.left, right: scrollRect.right, top: scrollRect.top, bottom: scrollRect.bottom },
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      };
    });

    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
    expect(geometry.scroll.left).toBeGreaterThan(geometry.dialog.left);
    expect(geometry.scroll.right).toBeLessThan(geometry.dialog.right);
    expect(geometry.scroll.top).toBeGreaterThan(geometry.dialog.top);
    expect(geometry.scroll.bottom).toBeLessThan(geometry.dialog.bottom);
    await expect(review.getByRole("region", { name: "Local App launch details" })).toHaveAttribute("tabindex", "0");
    await expect(review.getByRole("button", { name: "Review & add" })).toBeVisible();

    await reviewScroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(reviewScroll).toHaveClass(/is-scrolling/);
  });

  test("edits a running Local App from the masked whole-tab workbench surface", async ({ page }, testInfo) => {
    const organization = await createOrganization(page.request);
    const chat = await createChat(page, organization.id);
    await selectOrganization(page, organization.id);
    await installLocalAppsStub(page);
    await page.setViewportSize({ width: 1500, height: 920 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

    await page.getByTestId("chat-side-panel-trigger").click();
    await page.getByTestId("chat-side-panel-empty-local-apps-target").click();
    await page.getByTestId("local-apps-add").click();
    const review = page.getByTestId("local-app-definition-review");
    await review.getByRole("button", { name: "Review & add" }).click();
    await page.getByTestId("local-apps-open-binding-a").click();
    const localView = page.getByTestId("local-app-view")
      .filter({ hasText: "MKT dashboard" });
    await localView.getByTestId("local-app-start").click();
    await expect(localView.getByTestId("local-app-webview")).toHaveAttribute(
      "src",
      "http://127.0.0.1:43123/outreach",
    );
    await page.getByTestId("chat-side-panel-keep-in-messenger").click();
    await expect(page.getByText("Moved to Messenger")).toBeVisible();

    const main = page.getByTestId("messenger-main-workbench");
    const localTab = main.getByRole("tab", { name: /MKT dashboard/ });
    await expect(main).toHaveClass(/messenger-main-workbench-surface/);
    const surface = await main.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundImage: style.backgroundImage,
        borderRadius: style.borderRadius,
      };
    });
    expect(surface.backgroundImage).not.toBe("none");
    expect(surface.borderRadius).not.toBe("0px");
    await expect(localTab).toHaveAttribute("aria-roledescription", "sortable");
    await expect(main.getByRole("button", {
      name: "Reorder MKT dashboard tab",
    })).toHaveCount(0);

    await localTab.hover();
    const more = main.getByRole("button", {
      name: "More options for MKT dashboard",
    });
    await more.click();
    await page.getByRole("menuitem", { name: "Project settings" }).click();
    const settings = page.getByTestId("local-app-definition-review");
    await settings.getByTestId("local-app-advanced-toggle").click();
    await expect(settings.getByLabel("Working directory")).toHaveValue(
      "/Users/zeeland/projects/uranus/rudder/mkt/dashboard",
    );
    await expect(settings.getByLabel("Name", { exact: true })).toBeDisabled();
    await expect(settings).toContainText(
      "Stop this Local App to edit its launch settings.",
    );
    await settings.getByRole("button", { name: "Cancel" }).click();
    expect((await calls(page)).stop ?? 0).toBe(0);

    await localTab.hover();
    await more.click();
    await page.getByRole("menuitem", { name: "Project settings" }).click();
    const editableSettings = page.getByTestId("local-app-definition-review");
    await editableSettings.getByRole("button", { name: "Stop & edit" }).click();
    await editableSettings.getByTestId("local-app-advanced-toggle").click();
    await expect(editableSettings.getByLabel("Name", { exact: true })).toBeEnabled();
    await editableSettings.getByLabel("Name", { exact: true })
      .fill("MKT command center");
    await editableSettings.getByLabel("Page to open after readiness")
      .fill("/overview");
    await editableSettings.getByRole("button", { name: "Review & save" }).click();
    await expect(main.getByRole("tab", { name: /MKT command center/ })).toBeVisible();
    expect((await calls(page)).stop).toBe(1);
    expect((await calls(page)).update).toBe(1);

    await page.screenshot({
      path: testInfo.outputPath("messenger-main-local-app-project-settings.png"),
      fullPage: true,
    });
  });
});
