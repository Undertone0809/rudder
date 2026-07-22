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
      value: { localApps },
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
    await review.getByRole("button", { name: "Review & add" }).click();

    const card = page.getByTestId("local-apps-app-binding-a");
    await expect(card).toContainText("MKT dashboard local");
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
    await page.screenshot({ path: "/tmp/rudder-local-app-running.png", fullPage: true });

    await page.getByTestId("chat-side-panel-keep-in-messenger").click();
    await expect(page.getByText("Kept in Messenger")).toBeVisible();
    const directory = await groups(page, organization.id);
    const savedEntry = directory.groups.flatMap((group) => group.entries)
      .find((entry) => entry.item.type === "saved_view")?.item;
    expect(savedEntry?.type).toBe("saved_view");
    if (!savedEntry || savedEntry.type !== "saved_view") throw new Error("Expected kept Local App");
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
    expect((await calls(page)).start).toBe(2);

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
    await activeCard.getByRole("button", { name: "Stop" }).click();
    await expect(activeCard).toContainText("stopped");
    expect((await calls(page)).stop).toBe(1);

    await activeCard.getByRole("button", { name: "Edit" }).click();
    const editReview = page.getByTestId("local-app-definition-review");
    await editReview.getByLabel("Name", { exact: true }).fill("MKT dashboard reviewed");
    await editReview.getByRole("button", { name: "Review & save" }).click();
    await expect(activeCard).toContainText("MKT dashboard reviewed");
    expect((await calls(page)).update).toBe(1);

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
    await page.goto(`/${organization.issuePrefix}/messenger`);
    const group = page.getByTestId(`messenger-thread-section-custom-group-${directory.groups[0]!.id}`);
    const row = group.locator('[data-testid^="messenger-saved-view-"]').filter({ hasText: "MKT dashboard local" });
    await row.hover();
    await row.getByRole("button", { name: "Saved View actions for MKT dashboard local" }).click();
    await page.getByRole("menuitem", { name: "Remove from Messenger" }).click();
    await expect.poll(async () => {
      const next = await groups(page, organization.id);
      return next.groups.flatMap((candidate) => candidate.entries)
        .some((entry) => entry.item.type === "saved_view" && entry.item.savedView.id === savedEntry.savedView.id);
    }).toBe(false);
    expect((await calls(page)).stop).toBe(1);
  });
});
