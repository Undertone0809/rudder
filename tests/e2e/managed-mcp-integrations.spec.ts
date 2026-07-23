import { expect, test, type Page, type Route } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { createLocalAgentJwt } from "../../server/src/agent-auth-jwt.ts";
import { E2E_BASE_URL, E2E_DATABASE_URL } from "./support/e2e-env";

const STDIO_MCP_FIXTURE = fileURLToPath(new URL(
  "../../server/src/services/mcp/__fixtures__/stdio-server.mjs",
  import.meta.url,
));
const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

type Connection = {
  id: string;
  orgId: string;
  name: string;
  displayName: string;
  provider: "supabase" | "linear" | "notion" | "custom";
  transport: "stdio" | "streamable_http";
  externalScope: string | null;
  accessMode: "provider_default" | "read_only" | "read_write";
  status: "draft" | "authorizing" | "selecting_scope" | "active" | "disabled" | "revoked" | "needs_reauth" | "error";
  safeConfig: Record<string, unknown>;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  enabled: boolean;
  required: boolean;
  hasCredentials: boolean;
  lastDiscoveredAt: string | null;
  activatedAt: string | null;
  disabledAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function connectionSummary(
  orgId: string,
  input: Record<string, unknown>,
): Connection {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    orgId,
    name: String(input.name),
    displayName: String(input.displayName),
    provider: input.provider as Connection["provider"],
    transport: input.transport as Connection["transport"],
    externalScope: null,
    accessMode: input.accessMode as Connection["accessMode"],
    status: "draft",
    safeConfig: input.safeConfig as Record<string, unknown>,
    startupTimeoutMs: Number(input.startupTimeoutMs),
    toolTimeoutMs: Number(input.toolTimeoutMs),
    enabled: input.enabled !== false,
    required: input.required === true,
    hasCredentials: Boolean(input.secrets),
    lastDiscoveredAt: null,
    activatedAt: null,
    disabledAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function installManagedMcpApiMock(
  page: Page,
  orgId: string,
  agentId: string,
) {
  const connections: Connection[] = [];
  const tools = new Map<string, Array<Record<string, unknown>>>();
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  let binding: { id: string; connectionId: string; agentId: string; status: string; enabledToolIds: string[] } | null = null;

  const routeJson = async (route: Route, body: unknown, status = 200) => {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  };

  await page.route(`**/api/orgs/${orgId}/mcp/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postDataJSON?.() ?? null;
    requests.push({ path, method, body });

    if (path.endsWith("/mcp/providers") && method === "GET") {
      await routeJson(route, [
        {
          id: "supabase",
          label: "Supabase",
          curated: true,
          requiresOAuth: true,
          requiresScopeSelection: true,
          scopeLabel: "Project",
          transports: ["streamable_http"],
          accessModes: ["read_only", "read_write"],
          defaultAccessMode: "read_only",
        },
        {
          id: "linear",
          label: "Linear",
          curated: true,
          requiresOAuth: true,
          requiresScopeSelection: false,
          scopeLabel: "Workspace",
          transports: ["streamable_http"],
          accessModes: ["read_only", "read_write"],
          defaultAccessMode: "read_write",
        },
        {
          id: "notion",
          label: "Notion",
          curated: true,
          requiresOAuth: true,
          requiresScopeSelection: false,
          scopeLabel: "Workspace",
          transports: ["streamable_http"],
          accessModes: ["provider_default"],
          defaultAccessMode: "provider_default",
        },
        {
          id: "custom",
          label: "Custom MCP",
          curated: false,
          requiresOAuth: false,
          requiresScopeSelection: false,
          scopeLabel: "Server",
          transports: ["stdio", "streamable_http"],
          accessModes: ["provider_default", "read_only", "read_write"],
          defaultAccessMode: "provider_default",
        },
      ]);
      return;
    }
    if (path.endsWith("/mcp/connections") && method === "GET") {
      await routeJson(route, connections);
      return;
    }
    if (path.endsWith("/mcp/connections") && method === "POST") {
      const input = body as Record<string, unknown>;
      if (input.provider === "custom") {
        const safe = JSON.stringify(input.safeConfig);
        expect(safe).not.toContain("secret-token");
        expect(safe).not.toContain("postgres://secret");
      }
      const created = connectionSummary(orgId, input);
      connections.push(created);
      tools.set(created.id, [{
        id: randomUUID(),
        connectionId: created.id,
        externalToolName: "search",
        rudderToolName: `external.${created.name}.search`,
        description: "Search the connected service.",
        inputSchema: { type: "object" },
        outputSchema: null,
        enabled: true,
        removedAt: null,
      }, {
        id: randomUUID(),
        connectionId: created.id,
        externalToolName: "write",
        rudderToolName: `external.${created.name}.write`,
        description: "Write through the connected service.",
        inputSchema: { type: "object" },
        outputSchema: null,
        enabled: true,
        removedAt: null,
      }]);
      await routeJson(route, created, 201);
      return;
    }

    const id = path.match(/\/mcp\/connections\/([^/]+)/)?.[1];
    const connection = connections.find((candidate) => candidate.id === id);
    if (!connection) {
      await routeJson(route, { error: "Not found" }, 404);
      return;
    }
    if (path.endsWith(`/mcp/connections/${connection.id}`) && method === "GET") {
      await routeJson(route, connection);
      return;
    }
    if (path.endsWith("/oauth/start") && method === "POST") {
      if (connection.provider === "supabase") {
        connection.status = "selecting_scope";
      } else {
        connection.status = "active";
        connection.externalScope = connection.provider === "linear"
          ? "workspace-linear"
          : "workspace-notion";
      }
      await routeJson(route, {
        connectionId: connection.id,
        authorizationUrl: `https://oauth.example.test/${connection.provider}`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }, 201);
      return;
    }
    if (path.endsWith("/oauth/scopes") && method === "GET") {
      await routeJson(route, [{
        id: "project-memos",
        displayName: "memos",
        metadata: { region: "local" },
      }]);
      return;
    }
    if (path.endsWith("/oauth/scope") && method === "POST") {
      connection.status = "active";
      connection.externalScope = String((body as { externalScope: string }).externalScope);
      connection.activatedAt = new Date().toISOString();
      await routeJson(route, { connection });
      return;
    }
    if (path.endsWith("/tools") && method === "GET") {
      await routeJson(route, tools.get(connection.id) ?? []);
      return;
    }
    if (path.endsWith("/refresh-tools") && method === "POST") {
      if (connection.provider === "custom") {
        connection.status = "active";
        connection.enabled = true;
        connection.activatedAt = connection.activatedAt ?? new Date().toISOString();
      }
      await routeJson(route, tools.get(connection.id) ?? []);
      return;
    }
    if (path.endsWith("/access-mode") && method === "PATCH") {
      connection.accessMode = (body as { accessMode: Connection["accessMode"] }).accessMode;
      await routeJson(route, connection);
      return;
    }
    if (path.endsWith("/reconnect") && method === "POST") {
      connection.status = connection.provider === "custom" ? "draft" : "active";
      connection.enabled = true;
      await routeJson(route, connection.provider === "custom"
        ? connection
        : {
            connectionId: connection.id,
            authorizationUrl: `https://oauth.example.test/${connection.provider}/reconnect`,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          });
      return;
    }
    if (path.endsWith("/disconnect") && method === "POST") {
      connection.status = "revoked";
      connection.enabled = false;
      connection.revokedAt = new Date().toISOString();
      await routeJson(route, connection);
      return;
    }
    await routeJson(route, { error: "Unhandled MCP mock route" }, 500);
  });

  await page.route(`**/api/agents/${agentId}/mcp-connections**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const connectionId = url.pathname.match(/\/mcp-connections\/([^/]+)/)?.[1];
    if (method === "GET") {
      await routeJson(route, connections
        .filter((connection) => connection.status === "active")
        .map((connection) => ({
          connection,
          binding: binding?.connectionId === connection.id ? binding : null,
          tools: tools.get(connection.id) ?? [],
        })));
      return;
    }
    const connection = connections.find((candidate) => candidate.id === connectionId);
    if (!connection) {
      await routeJson(route, { error: "Not found" }, 404);
      return;
    }
    if (method === "PUT" || method === "PATCH") {
      const input = request.postDataJSON() as { enabledToolIds?: string[] };
      binding = {
        id: binding?.id ?? randomUUID(),
        connectionId: connection.id,
        agentId,
        status: "active",
        enabledToolIds: input.enabledToolIds
          ?? (tools.get(connection.id) ?? []).map((tool) => String(tool.id)),
      };
      await routeJson(route, {
        connection,
        binding,
        tools: tools.get(connection.id) ?? [],
      });
      return;
    }
    if (method === "DELETE" && binding) {
      binding = { ...binding, status: "revoked" };
      await routeJson(route, {
        connection,
        binding,
        tools: tools.get(connection.id) ?? [],
      });
      return;
    }
    await routeJson(route, { error: "Unhandled binding mock route" }, 500);
  });

  return { connections, tools, requests, getBinding: () => binding };
}

test.describe("Managed MCP integrations", () => {
  test("connects official and custom MCPs, then binds an explicit agent tool allowlist", async ({ page }) => {
    test.setTimeout(180_000);
    const orgResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `Managed MCP ${Date.now()}` },
    });
    expect(orgResponse.ok()).toBe(true);
    const organization = await orgResponse.json() as { id: string; issuePrefix: string };
    const agentResponse = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/agents`,
      { data: { name: "MCP Operator", role: "engineer", agentRuntimeType: "codex_local" } },
    );
    expect(agentResponse.ok()).toBe(true);
    const agent = await agentResponse.json() as { id: string };

    await page.addInitScript(({ orgId }) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.open = () => ({
        opener: null,
        close() {},
        location: { replace() {} },
      } as unknown as Window);
    }, { orgId: organization.id });
    const mock = await installManagedMcpApiMock(page, organization.id, agent.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/organization/settings`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("tab", { name: "Integrations / MCPs" }).click();
    await expect(page.getByTestId("organization-mcp-settings")).toBeVisible();

    await page.getByTestId("mcp-provider-supabase").getByRole("button", { name: "Connect" }).click();
    const supabaseRow = page.getByTestId(`mcp-connection-${mock.connections[0]!.id}`);
    await expect(supabaseRow).toContainText("Choose scope");
    await supabaseRow.getByLabel("Project").selectOption("project-memos");
    await supabaseRow.getByRole("button", { name: "Use project" }).click();
    await expect(supabaseRow).toContainText("Connected");
    await expect(supabaseRow).toContainText("project-memos");

    await page.getByTestId("mcp-provider-linear").getByRole("button", { name: "Read-only" }).click();
    const linearRow = page.getByTestId(`mcp-connection-${mock.connections[1]!.id}`);
    await expect(linearRow).toContainText("read only");
    await linearRow.getByLabel("Access mode for Linear").selectOption("read_write");
    await expect(linearRow).toContainText("read write");

    await page.getByTestId("mcp-provider-notion").getByRole("button", { name: "Connect" }).click();
    await expect(page.getByTestId(`mcp-connection-${mock.connections[2]!.id}`)).toContainText("workspace-notion");

    await page.getByTestId("mcp-provider-custom").getByRole("button", { name: "Configure" }).click();
    let dialog = page.getByRole("dialog", { name: "Connect a custom MCP" });
    await dialog.getByPlaceholder("MCP server name").fill("Secure HTTP MCP");
    await dialog.getByPlaceholder("https://mcp.example.com/mcp").fill("https://mcp.example.test/mcp");
    await dialog.getByLabel("Static header 1").fill("Authorization");
    await dialog.getByLabel("Value 1").fill("Bearer secret-token");
    await dialog.getByRole("button", { name: "Save connection" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Secure HTTP MCP", { exact: true })).toBeVisible();

    await page.getByTestId("mcp-provider-custom").getByRole("button", { name: "Configure" }).click();
    dialog = page.getByRole("dialog", { name: "Connect a custom MCP" });
    await dialog.getByPlaceholder("MCP server name").fill("Local STDIO MCP");
    await dialog.getByRole("button", { name: "STDIO" }).click();
    await dialog.getByPlaceholder("npx").fill("node");
    await dialog.getByRole("textbox", { name: "Argument 1", exact: true }).fill("./mock-mcp.mjs");
    await dialog.getByLabel("Variable 1").fill("DATABASE_URL");
    await dialog.getByLabel("Secret value 1").fill("postgres://secret");
    await dialog.getByRole("button", { name: "Save connection" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Local STDIO MCP", { exact: true })).toBeVisible();

    const httpConnection = mock.connections.find((connection) => connection.displayName === "Secure HTTP MCP")!;
    const httpRow = page.getByTestId(`mcp-connection-${httpConnection.id}`);
    await httpRow.getByRole("button", { name: "Tools" }).click();
    await expect(httpRow.getByText(/external\..*\.search/)).toBeVisible();
    await httpRow.getByRole("button", { name: "Refresh" }).click();

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/${agent.id}/integrations`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "Manage" }).click();
    const managedSection = page.getByTestId("agent-managed-mcp-connections");
    await expect(managedSection).toBeVisible();
    const connectionCard = managedSection.getByTestId(
      `agent-mcp-connection-${httpConnection.id}`,
    );
    await connectionCard.getByRole("button", { name: "Bind all current tools" }).click();
    await expect(connectionCard.getByText("Tool allowlist")).toBeVisible();
    expect(mock.getBinding()?.enabledToolIds).toHaveLength(2);

    const firstToolCheckbox = connectionCard.getByRole("checkbox").first();
    await firstToolCheckbox.click();
    await expect.poll(() => mock.getBinding()?.enabledToolIds.length).toBe(1);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/organization/settings`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("tab", { name: "Integrations / MCPs" }).click();
    const restoredHttpRow = page.getByTestId(`mcp-connection-${httpConnection.id}`);
    await restoredHttpRow.getByRole("button", { name: "Disconnect" }).click();
    await expect(restoredHttpRow).toContainText("Disconnected");
    await restoredHttpRow.getByRole("button", { name: "Reconnect" }).click();
    await expect(restoredHttpRow).toContainText("Connected");

    expect(JSON.stringify(mock.connections)).not.toContain("secret-token");
    expect(JSON.stringify(mock.connections)).not.toContain("postgres://secret");
    expect(mock.requests.some((entry) =>
      entry.path.endsWith("/disconnect") && entry.method === "POST")).toBe(true);
  });

  test("discovers and binds a real local STDIO MCP through Rudder services", async ({ page }) => {
    test.setTimeout(120_000);
    const orgResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `Managed MCP black box ${Date.now()}` },
    });
    expect(orgResponse.ok()).toBe(true);
    const organization = await orgResponse.json() as { id: string; issuePrefix: string };
    const agentResponse = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/agents`,
      { data: { name: "Black-box MCP Operator", role: "engineer", agentRuntimeType: "codex_local" } },
    );
    expect(agentResponse.ok()).toBe(true);
    const agent = await agentResponse.json() as { id: string };

    const secretValue = `black-box-secret-${randomUUID()}`;
    const connectionResponse = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/mcp/connections`,
      {
        data: {
          name: `black-box-stdio-${Date.now().toString(36)}`,
          displayName: "Real STDIO MCP",
          provider: "custom",
          transport: "stdio",
          accessMode: "provider_default",
          safeConfig: {
            command: process.execPath,
            args: [STDIO_MCP_FIXTURE],
            secretEnvNames: ["SECRET_ENV"],
            toolAllowlist: ["inspect"],
          },
          secrets: { env: { SECRET_ENV: secretValue } },
          enabled: true,
          required: false,
          startupTimeoutMs: 10_000,
          toolTimeoutMs: 60_000,
        },
      },
    );
    expect(connectionResponse.ok()).toBe(true);
    const connectionText = await connectionResponse.text();
    expect(connectionText).not.toContain(secretValue);
    const connection = JSON.parse(connectionText) as Connection;

    const discoveryResponse = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/mcp/connections/${connection.id}/refresh-tools`,
    );
    expect(discoveryResponse.ok()).toBe(true);
    const discovered = await discoveryResponse.json() as Array<{
      id: string;
      externalToolName: string;
    }>;
    expect(discovered.map((tool) => tool.externalToolName)).toEqual(["inspect"]);

    const persistedResponse = await page.request.get(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/mcp/connections/${connection.id}`,
    );
    expect(await persistedResponse.text()).not.toContain(secretValue);

    await page.addInitScript(({ orgId }) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, { orgId: organization.id });
    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/organization/settings`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("tab", { name: "Integrations / MCPs" }).click();
    const connectionRow = page.getByTestId(`mcp-connection-${connection.id}`);
    await expect(connectionRow).toContainText("Real STDIO MCP");
    await expect(connectionRow).toContainText("Connected");

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/${agent.id}/integrations`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "Manage" }).click();
    const agentConnection = page.getByTestId(`agent-mcp-connection-${connection.id}`);
    await agentConnection.getByRole("button", { name: "Bind all current tools" }).click();
    await expect(agentConnection.getByText("Tool allowlist")).toBeVisible();
    await expect(agentConnection.getByRole("checkbox")).toBeChecked();

    const bindingsResponse = await page.request.get(
      `${E2E_BASE_URL}/api/agents/${agent.id}/mcp-connections?orgId=${organization.id}`,
    );
    expect(bindingsResponse.ok()).toBe(true);
    const summaries = await bindingsResponse.json() as Array<{
      connection: { id: string };
      binding: { id: string; status: string } | null;
      tools: Array<{ rudderToolName: string }>;
    }>;
    const summary = summaries.find((candidate) => candidate.connection.id === connection.id);
    expect(summary?.binding?.status).toBe("active");
    expect(summary?.tools).toHaveLength(1);

    const runId = randomUUID();
    await e2eDb.insert(heartbeatRuns).values({
      id: runId,
      orgId: organization.id,
      agentId: agent.id,
      invocationSource: "on_demand",
      triggerDetail: "managed_mcp_black_box",
      status: "running",
      startedAt: new Date(),
    });
    const agentJwt = createLocalAgentJwt(
      agent.id,
      organization.id,
      "codex_local",
      runId,
    );
    expect(agentJwt).toBeTruthy();

    const runtimeResponse = await page.request.post(
      `${E2E_BASE_URL}/api/mcp/runtime/bindings/${summary!.binding!.id}`,
      {
        headers: {
          Authorization: `Bearer ${agentJwt}`,
          "x-rudder-run-id": runId,
        },
        data: {
          jsonrpc: "2.0",
          id: "black-box-tool-call",
          method: "tools/call",
          params: {
            name: summary!.tools[0]!.rudderToolName,
            arguments: {},
          },
        },
      },
    );
    expect(runtimeResponse.ok()).toBe(true);
    const runtimeBody = await runtimeResponse.json() as {
      error?: unknown;
      result?: {
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: { secretEnv?: string };
      };
    };
    expect(runtimeBody.error).toBeUndefined();
    expect(runtimeBody.result?.content).toEqual([{ type: "text", text: "ok" }]);
    expect(runtimeBody.result?.structuredContent?.secretEnv).toBe(secretValue);
  });
});
