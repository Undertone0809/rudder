import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import { appBuilderApps, createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { strToU8, zipSync } from "../../server/node_modules/fflate/esm/index.mjs";
import { createLocalAgentJwt } from "../../server/src/agent-auth-jwt.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import {
  E2E_BASE_URL,
  E2E_CONFIG_PATH,
  E2E_DATABASE_URL,
  E2E_HOME,
  E2E_INSTANCE_ID,
} from "./support/e2e-env";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/codex-plugin-research", import.meta.url));
const mcpFixture = fileURLToPath(new URL("./fixtures/plugin-mcp-server.mjs", import.meta.url));
const e2eDb = createDb(E2E_DATABASE_URL);

process.env.RUDDER_HOME = E2E_HOME;
process.env.RUDDER_INSTANCE_ID = E2E_INSTANCE_ID;
process.env.RUDDER_CONFIG = E2E_CONFIG_PATH;

test.use({ serviceWorkers: "block" });

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function uploadPluginFolder(page: Page, revision: "v1" | "v2" = "v1") {
  const manifest = JSON.parse(await readFile(`${fixtureDirectory}/.codex-plugin/plugin.json`, "utf8")) as Record<string, unknown>;
  if (revision === "v2") manifest.version = "2.0.0";
  manifest.mcpServers = {
    research: {
      command: process.execPath,
      args: [mcpFixture],
      env: { PLUGIN_MODE: revision === "v2" ? "reviewed-v2" : "reviewed-v1" },
    },
  };
  const skill = await readFile(`${fixtureDirectory}/skills/evidence/SKILL.md`, "utf8");
  const synthesisSkill = await readFile(`${fixtureDirectory}/skills/synthesis/SKILL.md`, "utf8");
  const files = await Promise.all([
    {
      path: ".codex-plugin/plugin.json",
      content: JSON.stringify(manifest),
      type: "application/json",
    },
    {
      path: "skills/evidence/SKILL.md",
      content: revision === "v2" ? `${skill}\nUse the reviewed version-two evidence procedure.\n` : skill,
      type: "text/markdown",
    },
    {
      path: "skills/synthesis/SKILL.md",
      content: synthesisSkill,
      type: "text/markdown",
    },
  ]);

  await page.getByTestId("plugin-folder-input").evaluate((input, payload) => {
    const transfer = new DataTransfer();
    for (const entry of payload) {
      const file = new File([entry.content], entry.path.split("/").at(-1)!, { type: entry.type });
      Object.defineProperty(file, "webkitRelativePath", {
        value: `codex-plugin-research/${entry.path}`,
      });
      transfer.items.add(file);
    }
    const fileInput = input as HTMLInputElement;
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  }, files);
}

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

async function readAgentRuntimeCapabilities(orgId: string, agentId: string) {
  const { agentRunContextService } = await import("../../server/src/services/agent-run-context.ts");
  const prepared = await agentRunContextService(e2eDb).prepareRuntimeConfig({
    scene: "chat",
    agent: {
      id: agentId,
      orgId,
      name: "Research Agent",
      role: "general",
      status: "idle",
      agentRuntimeType: "claude_local",
      agentRuntimeConfig: {},
      metadata: null,
    },
  });
  return {
    skillNames: prepared.runtimeSkillEntries.map((entry) => entry.name),
    mcpBindings: prepared.runtimeConfig.managedExternalMcpBindings as Array<{
      bindingId: string;
      serverName: string;
    }>,
  };
}

test.describe("Plugins V1", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/orgs\/[^/]+\/plugins\/catalog$/, async (route) => {
      await route.fulfill({
        status: 200,
        json: { entries: [], freshness: "fresh", updatedAt: "2026-08-14T00:00:00.000Z" },
      });
    });
  });

  test("gates the Hub rail behind Experimental Plugins while preserving direct routes", async ({ page }, testInfo) => {
    const organization = await createOrganization(page.request, "Plugins-Rail-Gate");
    await page.request.patch(`${E2E_BASE_URL}/api/instance/settings/general`, {
      data: { experimentalPluginsEnabled: false },
    });
    await selectOrganization(page, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/dashboard`);
    await expect(page.getByTestId("primary-rail").getByText("Hub", { exact: true })).toHaveCount(0);
    await page.screenshot({
      path: `/tmp/rudder-hub-rail-disabled-${testInfo.workerIndex}.png`,
      fullPage: true,
    });

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/hub`);
    await expect(page.getByRole("heading", { name: "Hub" })).toBeVisible();
    await expect(page.getByTestId("primary-rail").getByText("Hub", { exact: true })).toHaveCount(0);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/apps`);
    await expect(page.getByTestId("apps-workspace")).toBeVisible();
    await expect(page.getByTestId("primary-rail").getByText("Hub", { exact: true })).toHaveCount(0);

    await page.goto(`${E2E_BASE_URL}/instance/settings/experimental`);
    const pluginsToggle = page.getByTestId("experimental-sites-toggle");
    await expect(pluginsToggle).toBeVisible();
    await pluginsToggle.click();
    await expect(pluginsToggle).toHaveAttribute("aria-checked", "true");

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/dashboard`);
    await expect(page.getByTestId("primary-rail").getByText("Hub", { exact: true })).toBeVisible();
    await page.screenshot({
      path: `/tmp/rudder-hub-rail-enabled-${testInfo.workerIndex}.png`,
      fullPage: true,
    });
  });

  test("imports, configures, disables, restores, isolates, and uninstalls a Codex Plugin", async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    const organization = await createOrganization(page.request, "Plugins-A");
    const otherOrganization = await createOrganization(page.request, "Plugins-B");
    const agentResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: { name: "Research Agent", role: "general", adapterType: "claude_local", adapterConfig: {} },
    });
    expect(agentResponse.ok(), await agentResponse.text()).toBe(true);
    const agent = await agentResponse.json() as { id: string };

    await page.request.patch(`${E2E_BASE_URL}/api/instance/settings/general`, {
      data: { experimentalPluginsEnabled: false },
    });
    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/dashboard`);
    await expect(page.getByTestId("primary-rail").getByText("Hub", { exact: true })).toHaveCount(0);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/hub`);
    await expect(page.getByRole("heading", { name: "Hub" })).toBeVisible();
    await expect(page.getByTestId("primary-rail").getByText("Hub", { exact: true })).toHaveCount(0);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/apps`);
    await expect(page.getByTestId("apps-workspace")).toBeVisible();
    await expect(page.getByTestId("primary-rail").getByText("Hub", { exact: true })).toHaveCount(0);

    await page.goto(`${E2E_BASE_URL}/instance/settings/experimental`);
    const pluginsToggle = page.getByTestId("experimental-sites-toggle");
    await expect(pluginsToggle).toBeVisible();
    await pluginsToggle.click();
    await expect(pluginsToggle).toHaveAttribute("aria-checked", "true");
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/dashboard`);
    await expect(page.getByTestId("primary-rail").getByText("Hub", { exact: true })).toBeVisible();

    let failDirectoryRequest = true;
    const directoryRoute = (url: URL) =>
      url.pathname === `/api/orgs/${organization.id}/plugins`;
    await page.route(directoryRoute, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        failDirectoryRequest
        && request.method() === "GET"
        && url.pathname === `/api/orgs/${organization.id}/plugins`
      ) {
        await route.fulfill({ status: 503, json: { error: "Temporary Plugin directory failure" } });
        return;
      }
      await route.continue();
    });
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/hub`);
    await expect(page.getByRole("alert")).toContainText("Temporary Plugin directory failure", {
      timeout: 60_000,
    });
    failDirectoryRequest = false;
    await page.unroute(directoryRoute);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Hub" })).toBeVisible();
    await expect(page.getByTestId("workspace-main-header-actions").getByTestId("hub-header-search")).toBeVisible();
    await expect(page.getByTestId("workspace-main-header-actions").getByRole("button", { name: "Import" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileHeaderActions = page.getByTestId("workspace-main-header-actions");
    const mobileImport = mobileHeaderActions.getByRole("button", { name: "Import" });
    await expect(mobileImport).toBeVisible();
    await mobileImport.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Import Plugin");
    await page.getByRole("button", { name: "skills", exact: true }).click();
    const mobileCreateSkill = mobileHeaderActions.getByRole("button", { name: "Create Skill" });
    await expect(mobileCreateSkill).toBeVisible();
    await mobileCreateSkill.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Create Skill");
    await page.getByRole("button", { name: "plugins", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId("hub-empty-installed")).toContainText("No plugins yet");
    await expect(page.getByTestId("hub-empty-marketplace")).toContainText("No plugins match this search");
    await expect(page.getByTestId("primary-rail").getByText("Hub", { exact: true })).toBeVisible();
    await expect(page.getByTestId("plugin-hub")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.getByTestId("plugin-hub-header")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    const existingSkill = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/skills`, {
      data: {
        name: "Existing Evidence",
        slug: "evidence",
        markdown: "---\nname: Existing Evidence\n---\n\n# Existing Evidence\n",
      },
    });
    expect(existingSkill.ok(), await existingSkill.text()).toBe(true);
    const standaloneSkillResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/skills`, {
      data: {
        name: "Standalone Notes",
        slug: "standalone-notes",
        markdown: "---\nname: Standalone Notes\n---\n\n# Standalone Notes\n",
      },
    });
    expect(standaloneSkillResponse.ok(), await standaloneSkillResponse.text()).toBe(true);
    const standaloneSkill = await standaloneSkillResponse.json() as { key: string };

    const inspectResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/api/orgs/${organization.id}/plugins/imports/inspect`)
      && response.request().method() === "POST");
    await uploadPluginFolder(page);
    const inspected = await inspectResponse;
    expect(inspected.ok(), await inspected.text()).toBe(true);
    const preview = page.getByRole("dialog");
    await expect(preview.getByRole("heading", { name: "Preview e2e-research-kit" })).toBeVisible();
    await expect(preview.getByText("Package inspection complete. Nothing has been executed.")).toBeVisible();
    await expect(preview.getByText("Evidence Research", { exact: true })).toBeVisible();
    await expect(preview.getByRole("radiogroup", { name: "Skill conflict strategy" })).toBeVisible();
    await expect(preview.getByText("Evidence Research conflicts with Existing Evidence", { exact: true })).toBeVisible();
    await page.screenshot({ path: "/tmp/rudder-plugins-v1-import-conflict.png", fullPage: true });
    await preview.getByText("Replace", { exact: true }).click();
    await preview.getByRole("button", { name: "Install" }).click();

    const detail = page.getByRole("dialog");
    await expect(detail.getByRole("heading", { name: "E2E Research Kit" })).toBeVisible({ timeout: 30_000 });
    await expect(detail.getByText("Setup required", { exact: true }).first()).toBeVisible();
    const directoryResponse = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/plugins`);
    const directory = await directoryResponse.json() as { installed: Array<{ id: string }> };
    const pluginId = directory.installed[0]!.id;
    expect((await page.request.get(`${E2E_BASE_URL}/api/orgs/${otherOrganization.id}/plugins/${pluginId}`)).status()).toBe(404);
    expect((await page.request.patch(`${E2E_BASE_URL}/api/orgs/${otherOrganization.id}/plugins/${pluginId}/enablement`, {
      data: { enabled: false },
    })).status()).toBe(404);
    expect((await page.request.get(`${E2E_BASE_URL}/api/plugins`)).status()).toBe(404);

    const unassignedPluginCatalog = page.waitForResponse((response) => (
      response.request().method() === "GET"
      && response.url().endsWith(`/api/orgs/${organization.id}/plugins`)
    ));
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/messenger/chat?agentId=${agent.id}`);
    await unassignedPluginCatalog;
    const unassignedComposer = page.locator(".chat-composer .rudder-mdxeditor-content").first();
    await unassignedComposer.click();
    await page.keyboard.type("@");
    await page.getByTestId(`markdown-mention-option-plugin:${pluginId}`).click();
    const unassignedMentionRequest = page.waitForRequest((request) => (
      request.method() === "POST"
      && request.url().includes(`/api/orgs/${organization.id}/chats/messages/stream`)
    ));
    await page.getByRole("button", { name: "Send" }).click();
    expect((await unassignedMentionRequest).postDataJSON()).toMatchObject({
      body: `[E2E Research Kit](plugin://${pluginId})`,
    });
    const beforeAssignment = await readAgentRuntimeCapabilities(organization.id, agent.id);
    expect(beforeAssignment.skillNames).not.toEqual(expect.arrayContaining(["Evidence Research", "Source Synthesis"]));
    expect(beforeAssignment.mcpBindings).toEqual([]);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/hub?tab=plugins`);
    await page.getByText("E2E Research Kit", { exact: true }).click();
    const setupButton = detail.getByRole("button", { name: "Set up" });
    await expect(setupButton).toBeVisible();
    await setupButton.click();
    await expect(detail.getByRole("link", { name: "Continue setup" })).toBeVisible();
    const setupPluginResponse = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/plugins/${pluginId}`);
    const setupPlugin = await setupPluginResponse.json() as {
      components: Array<{ id: string; type: string; targetId: string | null }>;
    };
    const mcpComponent = setupPlugin.components.find((component) => component.type === "mcp")!;
    expect(mcpComponent.targetId).toBeTruthy();
    await detail.getByRole("link", { name: "Continue setup" }).click();
    await expect(page).toHaveURL(/\/organization\/settings\?view=integrations$/);
    const enableMcp = await page.request.patch(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/mcp/connections/${mcpComponent.targetId}`,
      { data: { enabled: true } },
    );
    expect(enableMcp.ok(), await enableMcp.text()).toBe(true);
    const discoverTools = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/mcp/connections/${mcpComponent.targetId}/refresh-tools`,
    );
    expect(discoverTools.ok(), await discoverTools.text()).toBe(true);
    const currentMcpAccessResponse = await page.request.get(
      `${E2E_BASE_URL}/api/agents/${agent.id}/mcp-connections`,
    );
    expect(currentMcpAccessResponse.ok(), await currentMcpAccessResponse.text()).toBe(true);
    const currentMcpAccess = (await currentMcpAccessResponse.json() as Array<{
      connection: { id: string };
      binding: null | { policyRevision: number };
    }>).find((entry) => entry.connection.id === mcpComponent.targetId);
    expect(currentMcpAccess).toBeTruthy();
    const bindMcp = await page.request.put(
      `${E2E_BASE_URL}/api/agents/${agent.id}/mcp-connections/${mcpComponent.targetId}`,
      {
        data: {
          accessMode: "full",
          status: "active",
          ...(currentMcpAccess!.binding
            ? { expectedRevision: currentMcpAccess!.binding.policyRevision }
            : {}),
        },
      },
    );
    expect(bindMcp.ok(), await bindMcp.text()).toBe(true);
    const boundMcp = await bindMcp.json() as {
      binding: { id: string; accessMode: string; policyRevision: number };
      tools: Array<{ rudderToolName: string }>;
    };

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/hub?tab=plugins`);
    await page.getByText("E2E Research Kit", { exact: true }).click();
    await detail.getByRole("button", { name: "Add to Agent" }).click();
    const assignment = page.getByRole("dialog", { name: "Add Skills to Agents" });
    await assignment.getByText("Research Agent", { exact: true }).click();
    await assignment.getByRole("button", { name: "Save" }).click();
    await expect(assignment).toHaveCount(0);
    const assignedPluginResponse = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/plugins/${pluginId}`);
    expect(assignedPluginResponse.ok(), await assignedPluginResponse.text()).toBe(true);
    expect(JSON.stringify(await assignedPluginResponse.json())).toContain(agent.id);
    const agentSkillsResponse = await page.request.get(
      `${E2E_BASE_URL}/api/agents/${agent.id}/skills?orgId=${encodeURIComponent(organization.id)}`,
    );
    expect(agentSkillsResponse.ok(), await agentSkillsResponse.text()).toBe(true);
    const agentSkills = await agentSkillsResponse.json() as { desiredSkills: string[] };
    const desiredSkills = [...agentSkills.desiredSkills, `org:${standaloneSkill.key}`];
    const syncSkills = await page.request.post(
      `${E2E_BASE_URL}/api/agents/${agent.id}/skills/sync?orgId=${encodeURIComponent(organization.id)}`,
      { data: { desiredSkills } },
    );
    expect(syncSkills.ok(), await syncSkills.text()).toBe(true);
    const afterAssignment = await readAgentRuntimeCapabilities(organization.id, agent.id);
    expect(afterAssignment.skillNames).toEqual(expect.arrayContaining(["Evidence Research", "Source Synthesis"]));
    expect(afterAssignment.mcpBindings).toEqual([
      expect.objectContaining({ serverName: "e2e-research-kit-research" }),
    ]);
    await page.request.patch(`${E2E_BASE_URL}/api/instance/settings/general`, {
      data: { experimentalPluginsEnabled: false },
    });
    const afterLegacyFlagWrite = await readAgentRuntimeCapabilities(organization.id, agent.id);
    expect(afterLegacyFlagWrite.skillNames).toEqual(expect.arrayContaining(["Evidence Research", "Source Synthesis"]));
    expect(afterLegacyFlagWrite.mcpBindings).toEqual([
      expect.objectContaining({ serverName: "e2e-research-kit-research" }),
    ]);
    const runtimeToolName = boundMcp.tools[0]!.rudderToolName;
    const runId = randomUUID();
    await e2eDb.insert(heartbeatRuns).values({
      id: runId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "on_demand",
      triggerDetail: "plugin_v1_mcp_black_box",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: {
        managedMcpPolicySnapshot: [{
          bindingId: boundMcp.binding.id,
          serverName: "e2e-research-kit-research",
          accessMode: boundMcp.binding.accessMode,
          policyRevision: boundMcp.binding.policyRevision,
          toolPolicy: {
            mode: "allowlist",
            allowedToolNames: [runtimeToolName],
          },
        }],
      },
    });
    const agentJwt = createLocalAgentJwt(agent.id, organization.id, "claude_local", runId);
    const toolCallResponse = await page.request.post(
      `${E2E_BASE_URL}/api/mcp/runtime/bindings/${boundMcp.binding.id}`,
      {
        headers: {
          Authorization: `Bearer ${agentJwt}`,
          "x-rudder-run-id": runId,
        },
        data: {
          jsonrpc: "2.0",
          id: "plugin-v1-tool-call",
          method: "tools/call",
          params: { name: runtimeToolName, arguments: {} },
        },
      },
    );
    expect(toolCallResponse.ok(), await toolCallResponse.text()).toBe(true);
    expect(await toolCallResponse.json()).toMatchObject({
      result: { content: [{ type: "text", text: "ready" }] },
    });

    await expect(page.getByRole("dialog").getByText("Ready", { exact: true }).first()).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Open UI" }).click();
    await expect(page.getByRole("dialog", { name: "E2E Research Kit" }).getByRole("button", { name: "Opening..." })).toBeDisabled();
    const mcpUi = page.getByRole("dialog", { name: "Research status" });
    await expect(mcpUi).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("dialog", { name: "E2E Research Kit" })).toHaveCount(0);
    await expect(mcpUi.locator("iframe").contentFrame().getByRole("heading", { name: "Research UI" })).toBeVisible();
    await mcpUi.getByRole("button", { name: "Close" }).click();
    await expect(mcpUi).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "E2E Research Kit" })).toBeVisible();

    await expect(detail.getByRole("button", { name: "Try in Chat" })).toBeVisible();
    await detail.getByRole("button", { name: "Try in Chat" }).click();
    await expect(page).toHaveURL(/\/messenger\/chat(?:\?|$)/);
    const composer = page.locator(".chat-composer .rudder-mdxeditor-content").first();
    await expect(composer).toContainText("E2E Research Kit");
    await composer.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("@");
    await expect(page.getByTestId(`markdown-mention-option-plugin:${pluginId}`)).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Standalone Notes/ })).toBeVisible();
    await expect(page.getByText("Evidence Research", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Source Synthesis", { exact: true })).toHaveCount(0);
    await page.getByTestId(`markdown-mention-option-plugin:${pluginId}`).click();
    await expect(composer).toContainText("E2E Research Kit");
    const pluginToken = composer.locator('[data-mention-kind="plugin"]');
    await expect(pluginToken).toHaveCount(1);
    const sendButton = page.getByRole("button", { name: "Send" });
    await expect(sendButton).toBeEnabled();
    const messageRequest = page.waitForRequest((request) => (
      request.method() === "POST"
      && request.url().includes(`/api/orgs/${organization.id}/chats/messages/stream`)
    ));
    await sendButton.click();
    expect((await messageRequest).postDataJSON()).toMatchObject({
      body: `[E2E Research Kit](plugin://${pluginId})`,
    });
    await expect(page).toHaveURL(/\/messenger\/chat(?:\/[^/?]+)?$/);
    const sentPluginMention = page.getByTestId("chat-user-message-bubble")
      .getByText("E2E Research Kit", { exact: true });
    await expect(sentPluginMention).toBeVisible();
    await sentPluginMention.click();
    await expect(page).toHaveURL(new RegExp(`/hub\\?tab=plugins&plugin=${pluginId}$`));

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/hub?tab=plugins`);
    await page.getByText("E2E Research Kit", { exact: true }).click();
    await detail.locator("section").filter({ hasText: "Included capabilities" })
      .locator("div.flex.min-h-12").filter({ hasText: "Evidence Research" })
      .getByRole("button", { name: "Customize" }).click();
    let customizedSkillId: string | null = null;
    await expect.poll(async () => {
      const skillsResponse = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/skills`);
      const skills = await skillsResponse.json() as Array<{ id: string; key: string; editable: boolean }>;
      customizedSkillId = skills.find((skill) => skill.key.includes("evidence-research-custom-") && skill.editable)?.id ?? null;
      return Boolean(customizedSkillId);
    }).toBe(true);

    await detail.getByRole("button", { name: "Disable" }).click();
    await expect(detail.getByText("Disabled", { exact: true }).first()).toBeVisible();
    await detail.getByRole("button", { name: "Enable" }).click();
    await expect(detail.getByText("Ready", { exact: true }).first()).toBeVisible();

    await detail.getByRole("button", { name: "Close" }).click();
    const updateInspectResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/api/orgs/${organization.id}/plugins/imports/inspect`)
      && response.request().method() === "POST");
    await uploadPluginFolder(page, "v2");
    expect((await updateInspectResponse).ok()).toBe(true);
    const updatePreview = page.getByRole("dialog");
    await expect(updatePreview.getByRole("heading", { name: "Preview update e2e-research-kit" })).toBeVisible();
    await expect(updatePreview.getByRole("heading", { name: "Capability changes" })).toBeVisible();
    await expect(updatePreview.getByText("Access expansion", { exact: true })).toBeVisible();
    const applyUpdate = updatePreview.getByRole("button", { name: "Apply update" });
    await expect(applyUpdate).toBeDisabled();
    await updatePreview.getByText("I understand and approve the expanded execution and external-access surface.").click();
    await updatePreview.getByText("Replace", { exact: true }).click();
    await expect(applyUpdate).toBeEnabled();
    await page.screenshot({ path: "/tmp/rudder-plugins-v1-update-review.png", fullPage: true });
    await applyUpdate.click();
    await expect(page.getByRole("dialog").getByText("2.0.0", { exact: true })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Roll back" }).click();
    await expect(page.getByRole("dialog").getByText("1.0.0", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog").getByText("Ready", { exact: true }).first()).toBeVisible();
    const rolledBackPluginResponse = await page.request.get(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/plugins/${pluginId}`,
    );
    expect(rolledBackPluginResponse.ok(), await rolledBackPluginResponse.text()).toBe(true);
    const rolledBackPlugin = await rolledBackPluginResponse.json() as {
      components: Array<{ type: string; targetId: string | null; status: string }>;
    };
    expect(rolledBackPlugin.components.find((component) => component.type === "mcp"))
      .toMatchObject({ targetId: mcpComponent.targetId, status: "ready" });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).first().click();
    await expect(page.getByRole("heading", { name: "Your plugins" })).toBeVisible();
    await page.screenshot({ path: `/tmp/rudder-plugins-v1-${testInfo.workerIndex}.png`, fullPage: true });

    const goalResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/goals`, {
      data: { title: "Preserved Plugin research goal", status: "active", level: "organization" },
    });
    expect(goalResponse.ok(), await goalResponse.text()).toBe(true);
    const goal = await goalResponse.json() as { id: string };
    const automationResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/automations`, {
      data: {
        title: "Preserved Plugin research automation",
        description: "Must survive Plugin uninstall.",
        assigneeAgentId: agent.id,
        outputMode: "track_issue",
      },
    });
    expect(automationResponse.ok(), await automationResponse.text()).toBe(true);
    const automation = await automationResponse.json() as { id: string };
    const documentResponse = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/library/documents`,
      { data: { title: "Preserved Plugin notes", format: "markdown", body: "# Preserved notes\n" } },
    );
    expect(documentResponse.ok(), await documentResponse.text()).toBe(true);
    const document = await documentResponse.json() as { id: string };

    await page.getByText("E2E Research Kit", { exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Uninstall" }).click();
    const confirmation = page.getByRole("dialog", { name: "Uninstall E2E Research Kit?" });
    await expect(confirmation).toContainText("Independent customized Skills");
    await confirmation.getByRole("button", { name: "Uninstall" }).click();
    await expect(page.getByText("No plugins yet", { exact: true })).toBeVisible();
    const skillsAfterUninstall = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/skills`);
    expect((await skillsAfterUninstall.json() as Array<{ id: string }>).some((skill) => skill.id === customizedSkillId)).toBe(true);
    expect((await page.request.get(`${E2E_BASE_URL}/api/goals/${goal.id}`)).ok()).toBe(true);
    expect((await page.request.get(`${E2E_BASE_URL}/api/automations/${automation.id}`)).ok()).toBe(true);
    expect((await page.request.get(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/library/documents/${document.id}`,
    )).ok()).toBe(true);
    const connectionsAfterUninstall = await page.request.get(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/mcp/connections`,
    );
    expect(connectionsAfterUninstall.ok(), await connectionsAfterUninstall.text()).toBe(true);
    expect((await connectionsAfterUninstall.json() as Array<{ id: string }>).some(
      (connection) => connection.id === mcpComponent.targetId,
    )).toBe(true);

    const appResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/app-builder`, {
      data: {
        name: "E2E Research Canvas",
        sourceRoot: `apps/e2e-research-${Date.now()}`,
        scaffoldVersion: "1",
      },
    });
    expect(appResponse.ok(), await appResponse.text()).toBe(true);
    const app = await appResponse.json() as { id: string; name: string };
    const desktopInstallationId = `desktop-plugin-e2e-${app.id}`;
    const appPublicId = `research-canvas-e2e-${app.id}`;
    const localBindingId = `binding-research-canvas-e2e-${app.id}`;
    const appPartition = `persist:${appPublicId}`;
    const appUpdatedAt = new Date(Date.now() + 1000);
    await e2eDb.update(appBuilderApps).set({
      buildStatus: "ready",
      desktopInstallationId,
      appPublicId,
      localBindingId,
      updatedAt: appUpdatedAt,
    }).where(eq(appBuilderApps.id, app.id));
    await page.addInitScript(({ appId, appName, desktopInstallationId, appPublicId, localBindingId, appPartition }) => {
      const definition = {
        id: localBindingId,
        desktopInstallationId,
        appPublicId,
        localBindingId,
        title: appName,
        executable: "node",
        argv: ["server.mjs"],
        cwd: "/tmp/e2e-research-canvas",
        inheritedEnvNames: [],
        readiness: { path: "/health", timeoutMs: 10_000 },
        openPath: "/",
        trustFingerprint: `trust-${appId}`,
        approvedFingerprint: `trust-${appId}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const running = {
        status: "running",
        generation: "plugin-e2e-generation",
        origin: "http://127.0.0.1:41791",
        openPath: "/",
        partition: appPartition,
      };
      Object.defineProperty(window, "desktopShell", {
        configurable: true,
        value: {
          localApps: {
            supported: true,
            list: async () => [definition],
            start: async () => running,
            stop: async () => ({ status: "stopped", generation: null }),
            status: async () => running,
            attestedTarget: async () => running,
            delete: async () => undefined,
          },
        },
      });
    }, { appId: app.id, appName: app.name, desktopInstallationId, appPublicId, localBindingId, appPartition });
    await page.reload();
    await expect(page.getByText("E2E Research Canvas", { exact: true })).toBeVisible();
    const withLocalApp = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/plugins`);
    const localAppDirectory = await withLocalApp.json() as { installed: Array<{ id: string; packageId: string; components: Array<{ type: string }> }> };
    const localAppPlugin = localAppDirectory.installed.find((plugin) => plugin.components.some((component) => component.type === "app"));
    expect(localAppPlugin).toBeTruthy();
    await page.reload();
    const firstLocalPackageId = localAppPlugin!.packageId;
    await page.getByText("E2E Research Canvas", { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/apps/view/managed%3A${app.id}$`, "i"));
    const appWebview = page.getByTestId("apps-local-webview");
    await expect(appWebview).toBeAttached();
    await expect(appWebview).toHaveAttribute("partition", appPartition);

    await e2eDb.update(appBuilderApps).set({ name: "E2E Research Canvas Revised", updatedAt: new Date(appUpdatedAt.getTime() + 1000) })
      .where(eq(appBuilderApps.id, app.id));
    const revisedDirectoryResponse = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/plugins`);
    const revisedDirectory = await revisedDirectoryResponse.json() as {
      installed: Array<{ id: string; packageId: string; previousPackageId: string | null; displayName: string; updateState: string; pendingUpdate: null | { displayName: string } }>;
    };
    const revisedLocalApp = revisedDirectory.installed.find((plugin) => plugin.id === localAppPlugin!.id)!;
    expect(revisedLocalApp).toMatchObject({
      displayName: "E2E Research Canvas",
      packageId: firstLocalPackageId,
      updateState: "review_required",
      pendingUpdate: { displayName: "E2E Research Canvas Revised" },
    });
    await expect(appWebview).toHaveAttribute("partition", appPartition);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/hub?tab=plugins`);
    await page.getByText("E2E Research Canvas", { exact: true }).click();
    const localAppReview = page.getByRole("dialog", { name: "E2E Research Canvas" });
    await expect(localAppReview.getByText("Local App update ready")).toBeVisible();
    await page.screenshot({ path: "/tmp/rudder-plugins-v1-local-app-review.png", fullPage: true });
    await localAppReview.getByRole("button", { name: "Apply update" }).click();
    await expect(localAppReview.getByRole("heading", { name: "E2E Research Canvas Revised" })).toBeVisible();
    const appliedDirectoryResponse = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/plugins`);
    const appliedDirectory = await appliedDirectoryResponse.json() as { installed: Array<{ id: string; packageId: string; previousPackageId: string | null; displayName: string }> };
    const appliedLocalApp = appliedDirectory.installed.find((plugin) => plugin.id === localAppPlugin!.id)!;
    expect(appliedLocalApp).toMatchObject({ displayName: "E2E Research Canvas Revised", previousPackageId: firstLocalPackageId });
    expect(appliedLocalApp.packageId).not.toBe(firstLocalPackageId);
    await localAppReview.getByRole("button", { name: "Close" }).click();
    const localAppUninstall = await page.request.delete(`${E2E_BASE_URL}/api/orgs/${organization.id}/plugins/${localAppPlugin!.id}`);
    expect(localAppUninstall.ok(), await localAppUninstall.text()).toBe(true);
    const appsAfterUninstallResponse = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/app-builder`);
    expect(appsAfterUninstallResponse.ok(), await appsAfterUninstallResponse.text()).toBe(true);
    const appsAfterUninstall = await appsAfterUninstallResponse.json() as Array<{ id: string }>;
    expect(appsAfterUninstall).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: app.id }),
    ]));
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/apps/view/managed%3A${app.id}`);
    await expect(appWebview).toHaveAttribute("partition", appPartition);
    const restoredLocalAppDirectory = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/plugins`);
    const restoredLocalApps = (await restoredLocalAppDirectory.json() as { installed: Array<{ id: string; displayName: string }> }).installed;
    expect(restoredLocalApps).toEqual(expect.arrayContaining([
      expect.objectContaining({ displayName: "E2E Research Canvas Revised" }),
    ]));
    expect(restoredLocalApps.find((plugin) => plugin.displayName === "E2E Research Canvas Revised")?.id).not.toBe(localAppPlugin!.id);
  });

  test("loads a review-only Codex marketplace and rejects a malformed ZIP", async ({ page }) => {
    test.setTimeout(180_000);
    const organization = await createOrganization(page.request, "Plugins-Marketplace");
    const malformedArchive = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/plugins/imports/inspect-archive`,
      {
        data: {
          sourceLabel: "malformed.zip",
          filename: "malformed.zip",
          content: Buffer.from("not a zip").toString("base64"),
          encoding: "base64",
        },
      },
    );
    expect(malformedArchive.status()).toBe(422);
    expect(await malformedArchive.text()).toContain("Invalid ZIP Plugin archive");

    const marketplace = {
      name: "e2e-team",
      plugins: [{
        name: "marketplace-e2e-kit",
        source: { source: "local", path: "./plugins/marketplace-e2e-kit" },
        policy: { installation: "INSTALLED_BY_DEFAULT", authentication: "ON_INSTALL" },
        category: "Productivity",
      }],
    };
    const pluginManifest = {
      name: "marketplace-e2e-kit",
      version: "1.0.0",
      description: "Marketplace review fixture.",
      interface: { displayName: "Marketplace E2E Kit", developerName: "E2E Team" },
      apps: ".app.json",
    };
    const configured = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/plugins/marketplaces`,
      {
        data: {
          sourceLabel: "E2E team marketplace",
          files: [
            { path: "marketplace.json", content: JSON.stringify(marketplace), encoding: "utf8" },
            { path: "plugins/marketplace-e2e-kit/.codex-plugin/plugin.json", content: JSON.stringify(pluginManifest), encoding: "utf8" },
            { path: "plugins/marketplace-e2e-kit/skills/review/SKILL.md", content: "---\nname: Marketplace Review\n---\n\n# Review\n", encoding: "utf8" },
            { path: "plugins/marketplace-e2e-kit/.app.json", content: JSON.stringify({ canvas: "asdk_app_e2e" }), encoding: "utf8" },
            { path: "plugins/marketplace-e2e-kit/hooks/install.js", content: "throw new Error('must never execute')", encoding: "utf8" },
          ],
        },
      },
    );
    expect(configured.ok(), await configured.text()).toBe(true);
    const reports = await configured.json() as Array<{ id: string }>;
    expect(reports).toHaveLength(1);
    const beforeInstall = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/plugins`);
    expect((await beforeInstall.json() as { installed: unknown[] }).installed).toEqual([]);

    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/hub?tab=plugins`);
    await expect(page.getByText("Marketplace E2E Kit", { exact: true })).toBeVisible();
    await page.screenshot({ path: "/tmp/rudder-plugins-v1-discover.png", fullPage: true });
    await page.getByText("Marketplace E2E Kit", { exact: true }).click();
    const preview = page.getByRole("dialog");
    await expect(preview.getByText("Marketplace Review", { exact: true })).toBeVisible();
    await expect(preview.getByText("canvas", { exact: true })).toBeVisible();
    await expect(preview.getByText("Hooks", { exact: true })).toBeVisible();
    await page.screenshot({ path: "/tmp/rudder-plugins-v1-marketplace-review.png", fullPage: true });
    await preview.getByRole("button", { name: "Install" }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Marketplace E2E Kit" })).toBeVisible();
    const installed = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/plugins`);
    expect((await installed.json() as { installed: Array<{ name: string }> }).installed)
      .toEqual([expect.objectContaining({ name: "marketplace-e2e-kit" })]);
  });

  test("imports a Skills-only ZIP, runs it, ignores the legacy gate, and rejects a digest conflict", async ({ page }) => {
    test.setTimeout(240_000);
    const organization = await createOrganization(page.request, "Plugins-Zip");
    const agent = await createE2EChatAgent(page.request, organization.id, {
      name: "ZIP Research Agent",
    }) as { id: string };
    const manifest = {
      name: "zip-research-kit",
      version: "1.0.0",
      description: "Skills-only ZIP acceptance fixture.",
      interface: { displayName: "ZIP Research Kit", developerName: "E2E" },
    };
    const skill = "---\nname: ZIP Research\ndescription: Research from a reviewed ZIP.\n---\n\n# ZIP Research\n";
    const archive = zipSync({
      "zip-research-kit/.codex-plugin/plugin.json": strToU8(JSON.stringify(manifest)),
      "zip-research-kit/skills/research/SKILL.md": strToU8(skill),
    });
    const inspectArchive = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/plugins/imports/inspect-archive`,
      {
        data: {
          sourceLabel: "zip-research-kit.zip",
          filename: "zip-research-kit.zip",
          content: Buffer.from(archive).toString("base64"),
          encoding: "base64",
        },
      },
    );
    expect(inspectArchive.ok(), await inspectArchive.text()).toBe(true);
    const report = await inspectArchive.json() as {
      id: string;
      status: string;
      components: Array<{ type: string; name: string }>;
    };
    expect(report).toMatchObject({
      status: "preview",
      components: [expect.objectContaining({ type: "skill", name: "ZIP Research" })],
    });
    const install = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/plugins/imports/${report.id}/install`,
      { data: { enabled: true } },
    );
    expect(install.ok(), await install.text()).toBe(true);
    const plugin = await install.json() as { id: string };
    const assign = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/plugins/${plugin.id}/skills/agents`,
      { data: { agentIds: [agent.id] } },
    );
    expect(assign.ok(), await assign.text()).toBe(true);

    const enabledRuntime = await readAgentRuntimeCapabilities(organization.id, agent.id);
    expect(enabledRuntime.skillNames).toContain("ZIP Research");
    await selectOrganization(page, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/hub?tab=plugins`);
    await page.getByText("ZIP Research Kit", { exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Try in Chat" }).click();
    const composer = page.locator(".chat-composer .rudder-mdxeditor-content").first();
    await expect(composer).toContainText("ZIP Research Kit");
    const sendButton = page.getByRole("button", { name: "Send" });
    await expect(sendButton).toBeEnabled();
    await sendButton.click();
    await expect(page).toHaveURL(/\/messenger\/chat\/[^/?#]+$/);
    await expect(page.getByTestId("chat-assistant-message").last()).toContainText(
      "Streaming reply for chat.",
      { timeout: 75_000 },
    );
    const chatId = new URL(page.url()).pathname.split("/").at(-1)!;
    const messagesResponse = await page.request.get(`${E2E_BASE_URL}/api/chats/${chatId}/messages`);
    expect(messagesResponse.ok(), await messagesResponse.text()).toBe(true);
    const assistant = (await messagesResponse.json() as Array<{
      role: string;
      status: string;
      runId: string | null;
    }>).findLast((message) => message.role === "assistant");
    expect(assistant).toMatchObject({ status: "completed", runId: expect.any(String) });
    const runResponse = await page.request.get(`${E2E_BASE_URL}/api/agent-runs/${assistant!.runId}`);
    expect(runResponse.ok(), await runResponse.text()).toBe(true);
    expect(await runResponse.json()).toMatchObject({
      id: assistant!.runId,
      agentId: agent.id,
      orgId: organization.id,
      status: "succeeded",
      invocationSource: "chat",
    });

    await page.request.patch(`${E2E_BASE_URL}/api/instance/settings/general`, {
      data: { experimentalPluginsEnabled: false },
    });
    expect((await readAgentRuntimeCapabilities(organization.id, agent.id)).skillNames)
      .toContain("ZIP Research");

    const digestConflict = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/plugins/imports/inspect`,
      {
        data: {
          sourceLabel: "same-version-different-content",
          sourceType: "local_upload",
          files: [
            { path: ".codex-plugin/plugin.json", content: JSON.stringify(manifest), encoding: "utf8" },
            { path: "skills/research/SKILL.md", content: `${skill}\nChanged without a version bump.\n`, encoding: "utf8" },
          ],
        },
      },
    );
    expect(digestConflict.ok(), await digestConflict.text()).toBe(true);
    const conflictReport = await digestConflict.json() as { status: string; errors: string[] };
    expect(conflictReport.status).toBe("failed");
    expect(conflictReport.errors).toContain(
      "The same Plugin name and version already exists with a different digest.",
    );
  });
});
