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
    await expect(page.getByRole("heading", {
      name: "Turn ideas into applications",
    })).toBeVisible();
    await expect(page.getByTestId("primary-rail").getByText("Apps", { exact: true }))
      .toBeVisible();
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
    await expect(page.getByText(/\$app-builder/).first()).toBeVisible({
      timeout: 20_000,
    });
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
          forceOpenExternal: async () => undefined,
          localApps: {
            supported: true,
            list: async () => definitions,
            discover: async () => ({ canceled: true }),
            create: async (definition: unknown) => definition,
            update: async (_id: string, definition: unknown) => definition,
            delete: async () => undefined,
            start: async (id: string) => {
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
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/apps`);

    const appsNavigation = page.getByRole("navigation", { name: "Apps" });
    await expect(appsNavigation.getByRole("button", { name: /Alpha CRM/ })).toBeVisible();
    await expect(appsNavigation.getByRole("button", { name: /Beta Dashboard/ })).toBeVisible();
    await appsNavigation.getByRole("button", { name: /Alpha CRM/ }).click();
    await expect(page.getByTestId("apps-tab-local:definition-alpha")).toBeVisible();
    await appsNavigation.getByRole("button", { name: /Beta Dashboard/ }).click();
    await expect(page.getByTestId("apps-tab-local:definition-beta")).toBeVisible();
    await expect(page.getByTestId("apps-tab-local:definition-alpha")).toBeVisible();

    await appsNavigation.getByRole("button", { name: /Alpha CRM/ }).click();
    await page.getByTestId("apps-start-app").click();
    await expect(page.getByTestId("apps-local-webview")).toBeAttached();
    const alphaIsolationKey = await page.getByTestId("apps-local-webview")
      .getAttribute("data-webview-isolation-key");
    await page.getByTestId("apps-local-webview").evaluate((element) => {
      (element as HTMLElement & { __appIsolationSentinel?: string })
        .__appIsolationSentinel = "alpha-guest";
    });

    await appsNavigation.getByRole("button", { name: /Beta Dashboard/ }).click();
    await page.getByTestId("apps-start-app").click();
    await expect(page.getByTestId("apps-local-webview")).toBeAttached();
    const betaIsolationKey = await page.getByTestId("apps-local-webview")
      .getAttribute("data-webview-isolation-key");
    expect(betaIsolationKey).not.toBe(alphaIsolationKey);
    await expect.poll(() => page.getByTestId("apps-local-webview").evaluate((element) => (
      (element as HTMLElement & { __appIsolationSentinel?: string }).__appIsolationSentinel
    ))).toBeUndefined();

    await appsNavigation.getByRole("button", { name: /Alpha CRM/ }).click();
    await expect(page.getByTestId("apps-local-webview")).toHaveAttribute(
      "data-webview-isolation-key",
      alphaIsolationKey!,
    );
    await page.getByTestId("apps-copy-link").click();
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { __copiedText?: string }).__copiedText
    ))).toBe("http://127.0.0.1:41731/");

    await page.screenshot({
      path: `/tmp/rudder-apps-e2e-tabs-${testInfo.workerIndex}.png`,
      fullPage: true,
    });
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
