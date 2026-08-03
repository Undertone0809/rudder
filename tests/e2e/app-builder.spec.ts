import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_BASE_URL } from "./support/e2e-env";

async function createOrganization(request: APIRequestContext, name: string) {
  const response = await request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: { name: `${name}-${Date.now()}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function selectOrganization(page: Page, orgId: string) {
  await page.goto(E2E_BASE_URL);
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

async function setSitesEnabled(request: APIRequestContext, enabled: boolean) {
  const response = await request.patch(
    `${E2E_BASE_URL}/api/instance/settings/general`,
    { data: { experimentalSitesEnabled: enabled } },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

test.describe("Apps workspace", () => {
  test.describe.configure({ mode: "serial" });

  test("reveals Apps from Experimental settings and creates an App Builder Chat", async ({
    page,
  }, testInfo) => {
    const organization = await createOrganization(page.request, "Apps-Home");
    await createE2EChatAgent(page.request, organization.id, {
      name: "App Builder Agent",
    });
    await setSitesEnabled(page.request, false);
    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/dashboard`);
    await expect(page.getByTestId("primary-rail").getByText("Apps", { exact: true }))
      .toHaveCount(0);

    await page.goto(`${E2E_BASE_URL}/instance/settings/experimental`);
    const toggle = page.getByTestId("experimental-sites-toggle");
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/apps`);
    await expect(page.getByTestId("apps-workspace")).toBeVisible();
    await expect(page.getByTestId("workspace-context-card")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Open Apps" })).toBeVisible();
    await expect(page.getByRole("heading", {
      name: "Turn ideas into applications",
    })).toBeVisible();
    await expect(page.getByText("Registered on this device")).toHaveCount(0);
    await expect(page.getByText("Your registered Apps will appear in the left sidebar."))
      .toHaveCount(0);
    await expect(page.getByText("How creation works")).toHaveCount(0);
    await expect(page.locator('[data-testid="apps-home"] svg.lucide-sparkles')).toHaveCount(0);
    await expect(page.getByTestId("primary-rail").getByText("Apps", { exact: true }))
      .toBeVisible();

    const contextCard = page.getByTestId("workspace-context-card");
    const collapseButton = page.getByRole("button", { name: "Collapse workspace sidebar" });
    const reopenZone = page.getByTestId("workspace-sidebar-reopen-zone");
    const reopenButton = page.getByTestId("workspace-sidebar-reopen-button");

    await collapseButton.click();
    await expect(contextCard).toHaveAttribute("aria-hidden", "true");
    await expect.poll(async () => contextCard.evaluate((element) => element.offsetWidth)).toBe(0);
    await expect(reopenButton).toHaveCSS("opacity", "0");
    await expect(reopenButton).toHaveCSS("pointer-events", "none");
    await page.screenshot({
      path: `/tmp/rudder-apps-e2e-collapsed-${testInfo.workerIndex}.png`,
      fullPage: true,
    });

    await reopenZone.hover();
    await expect(reopenButton).toBeVisible();
    await page.screenshot({
      path: `/tmp/rudder-apps-e2e-hover-${testInfo.workerIndex}.png`,
      fullPage: true,
    });
    await reopenButton.click();
    await expect(contextCard).toHaveAttribute("aria-hidden", "false");

    await page.getByRole("button", { name: "Collapse workspace sidebar" }).click();
    await reopenButton.focus();
    await expect(reopenButton).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(contextCard).toHaveAttribute("aria-hidden", "false");

    await page.getByRole("button", { name: "Collapse workspace sidebar" }).click();
    await reopenButton.focus();
    await page.keyboard.press("Space");
    await expect(contextCard).toHaveAttribute("aria-hidden", "false");

    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.waitForTimeout(400);
    await page.screenshot({
      path: `/tmp/rudder-apps-e2e-home-${testInfo.workerIndex}.png`,
      fullPage: true,
    });

    const chatResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().endsWith(`/api/orgs/${organization.id}/chats/messages/stream`)
    ));
    const appResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().endsWith(`/api/orgs/${organization.id}/app-builder`)
    ));
    const attachConversationResponse = page.waitForResponse((response) => (
      response.request().method() === "PATCH"
      && /\/api\/app-builder\/[^/]+\/conversation\?orgId=/.test(response.url())
    ));
    await page.getByTestId("apps-idea-input").fill(
      "Cold email CRM for contacts, sequences, replies, and follow-ups",
    );
    await page.getByTestId("apps-create-submit").click();

    expect((await chatResponse).status()).toBe(201);
    const createdAppResponse = await appResponse;
    expect(createdAppResponse.status(), await createdAppResponse.text()).toBe(201);
    const createdApp = await createdAppResponse.json() as {
      sourceRoot: string;
    };
    expect(createdApp.sourceRoot).toMatch(
      /^apps\/cold-email-crm-[a-z0-9-]+-[a-z0-9]{8}$/,
    );
    expect((await attachConversationResponse).status()).toBe(200);
    await expect(page).toHaveURL(/\/messenger\/chat\/[^/?#]+$/);
    await expect(page.getByRole("button", { name: "Stop streaming" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Thinking", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("chat-assistant-message")).toHaveCount(0);
    await expect(page.getByText(/\$app-builder/).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("chat-assistant-message")).toHaveCount(1, {
      timeout: 20_000,
    });
    await expect(page.getByTestId("chat-assistant-message")).toContainText("Streaming reply");
  });

  test("offers Agent creation and local web project loading from the Apps add menu", async ({
    page,
  }, testInfo) => {
    const organization = await createOrganization(page.request, "Apps-Add");
    await createE2EChatAgent(page.request, organization.id, {
      name: "App Builder Agent",
    });
    await setSitesEnabled(page.request, true);
    await page.addInitScript(() => {
      const savedDefinition = {
        id: "definition-added",
        desktopInstallationId: "desktop-e2e",
        appPublicId: "added-project",
        localBindingId: "binding-added",
        title: "Existing Vue dashboard",
        executable: "pnpm",
        argv: ["dev", "--host", "127.0.0.1"],
        cwd: "/tmp/existing-vue-dashboard",
        inheritedEnvNames: [],
        readiness: { path: "/", timeoutMs: 10_000 },
        openPath: "/dashboard",
        trustFingerprint: "trust-added",
        approvedFingerprint: "trust-added",
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      };
      Object.defineProperty(window, "desktopShell", {
        configurable: true,
        value: {
          localApps: {
            supported: true,
            list: async () => [],
            discover: async () => {
              const testWindow = window as typeof window & { __localAppDiscoveries?: number };
              testWindow.__localAppDiscoveries = (testWindow.__localAppDiscoveries ?? 0) + 1;
              const {
                id: _id,
                desktopInstallationId: _desktopInstallationId,
                appPublicId: _appPublicId,
                localBindingId: _localBindingId,
                approvedFingerprint: _approvedFingerprint,
                createdAt: _createdAt,
                updatedAt: _updatedAt,
                ...draft
              } = savedDefinition;
              return { canceled: false, draft };
            },
            create: async () => {
              const testWindow = window as typeof window & { __localAppCreations?: number };
              testWindow.__localAppCreations = (testWindow.__localAppCreations ?? 0) + 1;
              return savedDefinition;
            },
            status: async () => ({ status: "stopped", generation: null }),
            attestedTarget: async () => null,
          },
        },
      });
    });
    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/apps`);

    await page.getByTestId("apps-add").click();
    const buildWithAgent = page.getByTestId("apps-build-with-agent");
    await expect(buildWithAgent).toBeVisible();
    await expect(page.locator('[data-slot="dropdown-menu-content"]')).toHaveCSS("opacity", "1");
    await expect(buildWithAgent).toContainText(
      "Create or improve a web App with App Builder.",
    );
    await expect(page.getByTestId("apps-add-local-project")).toContainText(
      "Load a Next.js, React, Vue, or other web project from this computer.",
    );
    await page.screenshot({
      path: `/tmp/rudder-apps-add-menu-${testInfo.workerIndex}.png`,
      fullPage: true,
    });

    await page.getByTestId("apps-add-local-project").click();
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __localAppDiscoveries?: number }).__localAppDiscoveries ?? 0
    ))).toBe(1);
    await expect(page.getByTestId("apps-add-local-project")).toHaveCount(0);
    const review = page.getByTestId("local-app-definition-review");
    await expect(review).toBeVisible();
    await expect(review.getByTestId("local-app-project-folder"))
      .toHaveText("/tmp/existing-vue-dashboard");
    await expect(review.getByTestId("local-app-start-command"))
      .toContainText("pnpm dev --host 127.0.0.1");
    await review.getByRole("button", { name: "Review & add" }).click();
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __localAppCreations?: number }).__localAppCreations ?? 0
    ))).toBe(1);
    await expect(page).toHaveURL(/\/apps\/view\/local%3Adefinition-added$/);
    await expect(page.getByTestId("apps-entry-local:definition-added")).toBeVisible();

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/apps`);
    await page.getByTestId("apps-add").click();
    await expect(page.getByTestId("apps-build-with-agent")).toBeVisible();
    await page.getByTestId("apps-build-with-agent").click();
    await expect(page).toHaveURL(/\/messenger\/chat(?:\?.*)?$/);
    const composer = page.getByTestId("chat-composer-editor-scroll")
      .locator("[contenteditable='true']").first();
    await expect(composer).toContainText("Use $app-builder to create or improve a Rudder App.");
    await expect(composer).toContainText(
      "Help me clarify what this local web app should do before building it.",
    );
  });

  test("loads registered Apps into the left column and supports multiple tabs", async ({
    page,
  }, testInfo) => {
    const organization = await createOrganization(page.request, "Apps-Tabs");
    await setSitesEnabled(page.request, true);
    await page.addInitScript(() => {
      const definitions = [
        {
          id: "definition-alpha",
          desktopInstallationId: "desktop-e2e",
          appPublicId: "alpha",
          localBindingId: "binding-alpha",
          title: "Alpha CRM",
          executable: "node",
          argv: ["server.mjs"],
          cwd: "/tmp/alpha",
          inheritedEnvNames: [],
          readiness: { path: "/health", timeoutMs: 10_000 },
          openPath: "/",
          trustFingerprint: "trust-alpha",
          approvedFingerprint: "trust-alpha",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: "definition-beta",
          desktopInstallationId: "desktop-e2e",
          appPublicId: "beta",
          localBindingId: "binding-beta",
          title: "Beta Dashboard",
          executable: "node",
          argv: ["server.mjs"],
          cwd: "/tmp/beta",
          inheritedEnvNames: [],
          readiness: { path: "/health", timeoutMs: 10_000 },
          openPath: "/",
          trustFingerprint: "trust-beta",
          approvedFingerprint: "trust-beta",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
      const runtime = new Map(definitions.map((definition) => [
        definition.id,
        {
          status: "stopped",
          generation: null,
          origin: undefined,
          openPath: definition.openPath,
          partition: `persist:${definition.appPublicId}`,
        },
      ]));
      Object.defineProperty(window, "desktopShell", {
        configurable: true,
        value: {
          copyText: async (text: string) => {
            (window as typeof window & { __copiedText?: string }).__copiedText = text;
          },
          openExternal: async () => undefined,
          forceOpenExternal: async (target: string) => {
            (window as typeof window & { __openedExternal?: string }).__openedExternal = target;
          },
          localApps: {
            supported: true,
            list: async () => definitions,
            discover: async () => ({ canceled: true }),
            create: async (definition: unknown) => definition,
            update: async (_id: string, definition: unknown) => definition,
            delete: async () => undefined,
            start: async (id: string) => {
              const testWindow = window as typeof window & {
                __failNextAppStart?: boolean;
                __startedApps?: string[];
              };
              testWindow.__startedApps = [...(testWindow.__startedApps ?? []), id];
              if (testWindow.__failNextAppStart) {
                delete testWindow.__failNextAppStart;
                const failed = {
                  status: "failed",
                  generation: `failed-${id}`,
                  error: "Local App readiness check failed for /",
                };
                runtime.set(id, failed);
                throw new Error(failed.error);
              }
              const definition = definitions.find((candidate) => candidate.id === id)!;
              const next = {
                status: "running",
                generation: `generation-${id}`,
                origin: "http://127.0.0.1:41731",
                openPath: definition.openPath,
                partition: `persist:${definition.appPublicId}`,
              };
              runtime.set(id, next);
              return next;
            },
            stop: async (id: string) => {
              const testWindow = window as typeof window & {
                __releaseAppStop?: () => void;
                __stoppedApps?: string[];
              };
              testWindow.__stoppedApps = [...(testWindow.__stoppedApps ?? []), id];
              runtime.set(id, {
                status: "stopping",
                generation: runtime.get(id)?.generation ?? null,
                origin: undefined,
                openPath: "/",
                partition: undefined,
              });
              await new Promise<void>((resolve) => {
                testWindow.__releaseAppStop = resolve;
              });
              delete testWindow.__releaseAppStop;
              const next = {
                status: "stopped",
                generation: null,
                origin: undefined,
                openPath: "/",
                partition: undefined,
              };
              runtime.set(id, next);
              return next;
            },
            status: async (id: string) => runtime.get(id),
            logs: async () => [],
            attestedTarget: async (id: string) => {
              const definition = definitions.find((candidate) => candidate.id === id)!;
              return {
                origin: "http://127.0.0.1:41731",
                openPath: definition.openPath,
                partition: `persist:${definition.appPublicId}`,
              };
            },
          },
        },
      });
    });
    await selectOrganization(page, organization.id);
    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.goto(
      `${E2E_BASE_URL}/${organization.issuePrefix}/apps/view/local%3Adefinition-alpha`,
    );
    await expect(page.getByTestId("apps-open-app")).toBeVisible();
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __startedApps?: string[] }).__startedApps ?? []
    ))).toEqual([]);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/apps`);

    const alphaEntry = page.getByTestId("apps-entry-local:definition-alpha");
    const betaEntry = page.getByTestId("apps-entry-local:definition-beta");
    await expect(alphaEntry).toBeVisible();
    await expect(betaEntry).toBeVisible();
    await alphaEntry.click();
    await expect(page.getByTestId("apps-tab-local:definition-alpha")).toBeVisible();
    await expect(page.getByTestId("apps-local-webview")).toBeAttached();
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __startedApps?: string[] }).__startedApps
    ))).toEqual(["definition-alpha"]);
    await betaEntry.click();
    await expect(page.getByTestId("apps-tab-local:definition-beta")).toBeVisible();
    await expect(page.getByTestId("apps-tab-local:definition-alpha")).toBeVisible();
    await expect(page.getByTestId("apps-tab-local:definition-beta").getByRole("tab"))
      .toHaveAttribute("aria-selected", "true");

    await page.getByTestId("apps-tab-local:definition-alpha").getByRole("tab").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("apps-tab-local:definition-beta").getByRole("tab"))
      .toBeFocused();
    await page.getByRole("searchbox", { name: "Search Apps" }).evaluate((input) => {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: "w",
      }));
    });
    await expect(page.getByTestId("apps-tab-local:definition-beta")).toBeVisible();

    await alphaEntry.click();
    await expect(page.getByTestId("apps-local-webview")).toHaveAttribute(
      "data-local-binding-id",
      "binding-alpha",
    );
    const alphaIsolationKey = await page.getByTestId("apps-local-webview")
      .getAttribute("data-webview-isolation-key");
    await page.getByTestId("apps-local-webview").evaluate((element) => {
      (element as HTMLElement & { __appIsolationSentinel?: string })
        .__appIsolationSentinel = "alpha-guest";
    });

    await betaEntry.click();
    await expect(page.getByTestId("apps-local-webview")).toHaveAttribute(
      "data-local-binding-id",
      "binding-beta",
    );
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __startedApps?: string[] }).__startedApps
    ))).toEqual(["definition-alpha", "definition-beta"]);
    const betaIsolationKey = await page.getByTestId("apps-local-webview")
      .getAttribute("data-webview-isolation-key");
    expect(betaIsolationKey).not.toBe(alphaIsolationKey);
    await expect.poll(() => page.getByTestId("apps-local-webview").evaluate((element) => (
      (element as HTMLElement & { __appIsolationSentinel?: string }).__appIsolationSentinel
    ))).toBeUndefined();

    await alphaEntry.click();
    await expect(page.getByTestId("apps-local-webview")).toHaveAttribute(
      "data-webview-isolation-key",
      alphaIsolationKey!,
    );
    await alphaEntry.hover();
    await page.getByTestId("apps-more-local:definition-alpha").click();
    await expect(page.getByRole("menuitem", { name: "App settings" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Stop App" })).toBeVisible();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: `/tmp/rudder-apps-e2e-menu-${testInfo.workerIndex}.png`,
      fullPage: true,
    });
    await page.getByTestId("apps-copy-link-local:definition-alpha").click();
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __copiedText?: string }).__copiedText
    ))).toBe("http://127.0.0.1:41731/");
    await alphaEntry.hover();
    await page.getByTestId("apps-more-local:definition-alpha").click();
    await page.getByRole("menuitem", { name: "Open in browser" }).click({
      force: true,
    });
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __openedExternal?: string }).__openedExternal
    ))).toBe("http://127.0.0.1:41731/");
    await expect(page.getByText("Source", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop App" })).toHaveCount(0);

    await page.getByTestId("apps-tab-local:definition-beta").getByRole("tab").focus();
    await page.keyboard.press("Delete");
    await expect(page.getByTestId("apps-tab-local:definition-beta")).toHaveCount(0);
    await expect(page.getByTestId("apps-tab-local:definition-alpha").getByRole("tab"))
      .toBeFocused();
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __stoppedApps?: string[] }).__stoppedApps ?? []
    ))).toEqual([]);

    await page.screenshot({
      path: `/tmp/rudder-apps-e2e-tabs-${testInfo.workerIndex}.png`,
      fullPage: true,
    });

    await alphaEntry.hover();
    await page.getByTestId("apps-more-local:definition-alpha").click();
    await page.getByRole("menuitem", { name: "Stop App" }).click({ force: true });
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __stoppedApps?: string[] }).__stoppedApps ?? []
    ))).toEqual(["definition-alpha"]);
    await page.evaluate(() => {
      (window as typeof window & { __releaseAppStop?: () => void }).__releaseAppStop?.();
    });
    await expect(page.getByTestId("apps-local-webview")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __startedApps?: string[] }).__startedApps ?? []
    ))).toEqual(["definition-alpha", "definition-beta"]);
    await alphaEntry.click();
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __startedApps?: string[] }).__startedApps ?? []
    ))).toEqual(["definition-alpha", "definition-beta", "definition-alpha"]);
    await expect(page.getByTestId("apps-local-webview")).toBeAttached();

    await alphaEntry.hover();
    await page.getByTestId("apps-more-local:definition-alpha").click();
    await page.getByRole("menuitem", { name: "Stop App" }).click({ force: true });
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __stoppedApps?: string[] }).__stoppedApps ?? []
    ))).toEqual(["definition-alpha", "definition-alpha"]);
    await alphaEntry.click();
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __startedApps?: string[] }).__startedApps ?? []
    ))).toEqual(["definition-alpha", "definition-beta", "definition-alpha"]);
    await page.evaluate(() => {
      (window as typeof window & { __releaseAppStop?: () => void }).__releaseAppStop?.();
    });
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __startedApps?: string[] }).__startedApps ?? []
    ))).toEqual([
      "definition-alpha",
      "definition-beta",
      "definition-alpha",
      "definition-alpha",
    ]);

    await alphaEntry.hover();
    await page.getByTestId("apps-more-local:definition-alpha").click();
    await page.getByRole("menuitem", { name: "Stop App" }).click({ force: true });
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __stoppedApps?: string[] }).__stoppedApps ?? []
    ))).toEqual(["definition-alpha", "definition-alpha", "definition-alpha"]);
    await page.evaluate(() => {
      (window as typeof window & { __failNextAppStart?: boolean }).__failNextAppStart = true;
    });
    await alphaEntry.click();
    await page.evaluate(() => {
      (window as typeof window & { __releaseAppStop?: () => void }).__releaseAppStop?.();
    });
    await expect(page.getByRole("heading", { name: "The App could not open" })).toBeVisible();
    await expect(page.getByTestId("apps-ask-ai")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open source" })).toHaveCount(0);
    await page.screenshot({
      path: `/tmp/rudder-apps-e2e-failure-${testInfo.workerIndex}.png`,
      fullPage: true,
    });
    await page.getByTestId("apps-ask-ai").click();
    await expect(page).toHaveURL(/\/messenger\/chat(?:\?.*)?$/);
    const composer = page.getByTestId("chat-composer-editor-scroll")
      .locator("[contenteditable='true']").first();
    await expect(composer).toContainText("A Local App could not open in Rudder Desktop.");
    await expect(composer).toContainText("Alpha CRM");
  });

  test("does not expose a managed local binding in another organization", async ({
    page,
  }) => {
    const firstOrganization = await createOrganization(page.request, "App-Binding-A");
    const secondOrganization = await createOrganization(page.request, "App-Binding-B");
    await setSitesEnabled(page.request, true);
    const createdResponse = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${firstOrganization.id}/app-builder`,
      {
        data: {
          name: "Private CRM",
          sourceRoot: "apps/private-crm",
          scaffoldVersion: "1",
        },
      },
    );
    expect(createdResponse.status(), await createdResponse.text()).toBe(201);
    const created = await createdResponse.json() as { id: string };
    const bindingResponse = await page.request.put(
      `${E2E_BASE_URL}/api/app-builder/${created.id}/local-binding?orgId=${firstOrganization.id}`,
      {
        data: {
          desktopInstallationId: "desktop-e2e",
          appPublicId: "private-crm",
          localBindingId: "binding-private-crm",
        },
      },
    );
    expect(bindingResponse.status(), await bindingResponse.text()).toBe(200);
    await page.addInitScript(() => {
      const definition = {
        id: "definition-private-crm",
        desktopInstallationId: "desktop-e2e",
        appPublicId: "private-crm",
        localBindingId: "binding-private-crm",
        title: "Private CRM",
        executable: "node",
        argv: ["server.mjs"],
        cwd: "/tmp/private-crm",
        inheritedEnvNames: [],
        readiness: { path: "/health", timeoutMs: 10_000 },
        openPath: "/",
        trustFingerprint: "trust-private",
        approvedFingerprint: "trust-private",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      Object.defineProperty(window, "desktopShell", {
        configurable: true,
        value: {
          localApps: {
            supported: true,
            list: async () => [definition],
            status: async () => ({ status: "stopped", generation: null }),
          },
        },
      });
    });
    await selectOrganization(page, secondOrganization.id);
    await page.goto(`${E2E_BASE_URL}/${secondOrganization.issuePrefix}/apps`);
    await expect(page.getByText("Private CRM")).toHaveCount(0);
  });

  test("keeps App Builder records organization-scoped", async ({ request }) => {
    const firstOrganization = await createOrganization(request, "App-Scope-A");
    const secondOrganization = await createOrganization(request, "App-Scope-B");
    const first = await request.post(
      `${E2E_BASE_URL}/api/orgs/${firstOrganization.id}/app-builder`,
      { data: { name: "CRM A", sourceRoot: "apps/crm-a", scaffoldVersion: "1" } },
    );
    expect(first.status(), await first.text()).toBe(201);
    const second = await request.post(
      `${E2E_BASE_URL}/api/orgs/${secondOrganization.id}/app-builder`,
      { data: { name: "CRM B", sourceRoot: "apps/crm-b", scaffoldVersion: "1" } },
    );
    expect(second.status(), await second.text()).toBe(201);

    const firstList = await request.get(
      `${E2E_BASE_URL}/api/orgs/${firstOrganization.id}/app-builder`,
    );
    expect(firstList.status(), await firstList.text()).toBe(200);
    const items = await firstList.json() as Array<{ name: string; projectId: string | null }>;
    expect(items).toEqual([
      expect.objectContaining({ name: "CRM A", projectId: null }),
    ]);
    expect(items.some((item) => item.name === "CRM B")).toBe(false);

    const projects = await request.get(
      `${E2E_BASE_URL}/api/orgs/${firstOrganization.id}/projects`,
    );
    expect(projects.status(), await projects.text()).toBe(200);
    expect(await projects.json()).toEqual([]);
  });
});
