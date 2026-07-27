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
  let heldOfficialProvider: Exclude<Connection["provider"], "custom"> | null = null;
  let releaseHeldOfficialConnect: (() => void) | null = null;
  const bindings = new Map<string, {
    id: string;
    connectionId: string;
    agentId: string;
    status: "active" | "disabled";
    accessMode: "none" | "read_only" | "read_write" | "provider_granted" | "full";
    policyRevision: number;
    enabledToolIds: string[];
  }>();

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
          requiresScopeSelection: false,
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
    if (path.endsWith("/mcp/provider-status") && method === "GET") {
      await routeJson(route, ["supabase", "linear", "notion"].map((provider) => {
        const connection = connections.find((candidate) => candidate.provider === provider);
        const connected = connection?.status === "active" && connection.enabled;
        return {
          provider,
          organization: {
            state: connected
              ? "connected"
              : connection?.status === "authorizing"
                ? "connecting"
                : connection?.status === "needs_reauth" || connection?.status === "error"
                  ? "needs_attention"
                  : connection
                    ? "disconnected"
                    : "not_connected",
            connectionId: connection?.id ?? null,
            maxAccess: connected
              ? connection!.provider === "notion"
                ? "provider_granted"
                : connection!.accessMode
              : null,
            scopeMode: connected
              ? connection!.provider === "supabase" ? "account" : "workspace"
              : null,
            revision: connection ? 1 : null,
          },
        };
      }));
      return;
    }
    if (path.endsWith("/mcp/connections") && method === "GET") {
      await routeJson(route, connections);
      return;
    }
    const officialProvider = path.match(/\/mcp\/providers\/(supabase|linear|notion)\/connect$/)?.[1];
    if (officialProvider && method === "POST") {
      if (officialProvider === heldOfficialProvider) {
        await new Promise<void>((resolve) => {
          releaseHeldOfficialConnect = resolve;
        });
        heldOfficialProvider = null;
        releaseHeldOfficialConnect = null;
      }
      let connection = connections.find((candidate) => candidate.provider === officialProvider);
      if (!connection) {
        connection = connectionSummary(orgId, {
          name: officialProvider,
          displayName: officialProvider[0]!.toUpperCase() + officialProvider.slice(1),
          provider: officialProvider,
          transport: "streamable_http",
          accessMode: (body as { accessMode?: Connection["accessMode"] } | null)?.accessMode
            ?? (officialProvider === "supabase"
              ? "read_only"
              : officialProvider === "linear"
                ? "read_write"
                : "provider_default"),
          safeConfig: {},
          startupTimeoutMs: 10_000,
          toolTimeoutMs: 60_000,
          enabled: true,
          required: false,
        });
        connections.push(connection);
        tools.set(connection.id, [{
          id: randomUUID(),
          connectionId: connection.id,
          externalToolName: "search",
          rudderToolName: `external.${connection.name}.search`,
          description: "Search the connected service.",
          inputSchema: { type: "object" },
          outputSchema: null,
          capabilityClass: "read",
          policyRevision: 1,
          catalogRevision: 1,
          enabled: true,
          removedAt: null,
        }, {
          id: randomUUID(),
          connectionId: connection.id,
          externalToolName: "write",
          rudderToolName: `external.${connection.name}.write`,
          description: "Write through the connected service.",
          inputSchema: { type: "object" },
          outputSchema: null,
          capabilityClass: "normal_write",
          policyRevision: 1,
          catalogRevision: 1,
          enabled: true,
          removedAt: null,
        }]);
      }
      await routeJson(route, connection);
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
        capabilityClass: "unknown",
        policyRevision: 1,
        catalogRevision: 1,
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
        capabilityClass: "unknown",
        policyRevision: 1,
        catalogRevision: 1,
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
      connection.status = "active";
      connection.activatedAt = new Date().toISOString();
      connection.externalScope = connection.provider === "supabase"
        ? null
        : connection.provider === "linear"
          ? "workspace-linear"
          : "workspace-notion";
      await routeJson(route, {
        connectionId: connection.id,
        authorizationUrl: `https://oauth.example.test/${connection.provider}`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }, 201);
      return;
    }
    if (path.endsWith("/oauth/scopes") && method === "GET") {
      await routeJson(route, { error: "Supabase project selection is obsolete" }, 410);
      return;
    }
    if (path.endsWith("/oauth/scope") && method === "POST") {
      await routeJson(route, { error: "Supabase project selection is obsolete" }, 410);
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

  await page.route(`**/api/agents/${agentId}/mcp-provider-status**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push({ path, method: request.method(), body: null });
    await routeJson(route, ["supabase", "linear", "notion"].map((provider) => {
      const connection = connections.find((candidate) => candidate.provider === provider);
      const binding = connection ? bindings.get(connection.id) : undefined;
      const connected = connection?.status === "active" && connection.enabled;
      return {
        provider,
        organization: {
          state: connected ? "connected" : connection ? "disconnected" : "not_connected",
          connectionId: connection?.id ?? null,
          maxAccess: connected
            ? connection!.provider === "notion" ? "provider_granted" : connection!.accessMode
            : null,
          scopeMode: connected
            ? connection!.provider === "supabase" ? "account" : "workspace"
            : null,
          revision: connection ? 1 : null,
        },
        agent: {
          access: binding?.accessMode ?? "none",
          activeRunUsesOlderPolicy: false,
        },
      };
    }));
  });

  await page.route(`**/api/agents/${agentId}/mcp-connections**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = request.postDataJSON?.() ?? null;
    requests.push({ path: url.pathname, method, body });
    const connectionId = url.pathname.match(/\/mcp-connections\/([^/]+)/)?.[1];
    if (method === "GET") {
      await routeJson(route, connections
        .filter((connection) => connection.status === "active")
        .map((connection) => ({
          connection,
          binding: bindings.get(connection.id) ?? null,
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
      const input = body as {
        accessMode?: "none" | "read_only" | "read_write" | "provider_granted" | "full";
        enabledToolIds?: string[];
      };
      const prior = bindings.get(connection.id);
      const accessMode = input.accessMode ?? prior?.accessMode ?? "none";
      const binding = {
        id: prior?.id ?? randomUUID(),
        connectionId: connection.id,
        agentId,
        status: accessMode === "none" ? "disabled" as const : "active" as const,
        accessMode,
        policyRevision: (prior?.policyRevision ?? 0) + 1,
        enabledToolIds: input.enabledToolIds
          ?? prior?.enabledToolIds
          ?? (tools.get(connection.id) ?? []).map((tool) => String(tool.id)),
      };
      bindings.set(connection.id, binding);
      await routeJson(route, {
        connection,
        binding,
        tools: tools.get(connection.id) ?? [],
      });
      return;
    }
    if (method === "DELETE" && bindings.has(connection.id)) {
      const binding = {
        ...bindings.get(connection.id)!,
        status: "disabled" as const,
        accessMode: "none" as const,
      };
      bindings.set(connection.id, binding);
      await routeJson(route, {
        connection,
        binding,
        tools: tools.get(connection.id) ?? [],
      });
      return;
    }
    await routeJson(route, { error: "Unhandled binding mock route" }, 500);
  });

  return {
    connections,
    tools,
    requests,
    holdOfficialConnect: (provider: Exclude<Connection["provider"], "custom">) => {
      heldOfficialProvider = provider;
    },
    releaseOfficialConnect: () => releaseHeldOfficialConnect?.(),
    getBinding: (connectionId: string) => bindings.get(connectionId) ?? null,
  };
}

test.describe("Managed MCP integrations", () => {
  test("shows loading only on the provider being connected", async ({ page }, testInfo) => {
    const orgResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: { name: `MCP loading isolation ${Date.now()}` },
    });
    expect(orgResponse.ok()).toBe(true);
    const organization = await orgResponse.json() as { id: string; issuePrefix: string };
    const agentResponse = await page.request.post(
      `${E2E_BASE_URL}/api/orgs/${organization.id}/agents`,
      { data: { name: "MCP Loading Operator", role: "engineer", agentRuntimeType: "codex_local" } },
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

    const supabaseConnect = page
      .getByTestId("mcp-provider-supabase")
      .getByRole("button", { name: "Connect" });
    const linearConnect = page
      .getByTestId("mcp-provider-linear")
      .getByRole("button", { name: "Connect" });
    const notionConnect = page
      .getByTestId("mcp-provider-notion")
      .getByRole("button", { name: "Connect" });

    mock.holdOfficialConnect("supabase");
    await supabaseConnect.click();

    try {
      await expect(supabaseConnect).toHaveAttribute("aria-busy", "true");
      await expect(linearConnect).not.toHaveAttribute("aria-busy", "true");
      await expect(notionConnect).not.toHaveAttribute("aria-busy", "true");
      await page.screenshot({
        path: testInfo.outputPath("mcp-provider-loading-isolation.png"),
        fullPage: true,
      });
    } finally {
      mock.releaseOfficialConnect();
    }
    await expect.poll(() => mock.connections.length).toBe(1);
  });

  test("connects account-scoped Supabase and manages coarse agent access in focused dialogs", async ({ page }) => {
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
    await expect(page.getByRole("tab", { name: "Discover", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("tab", { name: "Manage", exact: true })).toBeVisible();

    await page.getByTestId("mcp-provider-supabase").getByRole("button", { name: "Connect" }).click();
    await expect.poll(() => mock.connections.length).toBe(1);
    const supabase = mock.connections[0]!;
    const supabaseCard = page.getByTestId("mcp-provider-supabase");
    await expect(supabaseCard).toContainText("Connected");
    await expect(supabaseCard.getByRole("button", { name: "Manage" })).toBeVisible();
    await expect(page.getByLabel("Project")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Use project" })).toHaveCount(0);

    const discoverManageButton = supabaseCard.getByRole("button", { name: "Manage" });
    await discoverManageButton.click();
    let dialog = page.getByRole("dialog", { name: "Manage Supabase" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("All authorized projects");
    await expect(dialog.getByRole("radio", { name: "Read only", exact: true })).toBeChecked();
    await expect(dialog.getByText("Tool allowlist")).toHaveCount(0);
    await expect(dialog.getByText(/external\.supabase\./)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(discoverManageButton).toBeFocused();

    await page.getByRole("tab", { name: "Manage", exact: true }).click();
    const supabaseRow = page.getByTestId(`mcp-connection-${supabase.id}`);
    await expect(supabaseRow).toContainText("Account access");
    await expect(supabaseRow).toContainText("Read only");
    await expect(supabaseRow.getByRole("button", { name: "Manage" })).toBeVisible();
    await expect(supabaseRow.getByRole("button", { name: "Tools" })).toHaveCount(0);
    await expect(supabaseRow.getByText(/external\.supabase\./)).toHaveCount(0);
    const rowManageButton = supabaseRow.getByRole("button", { name: "Manage" });
    await rowManageButton.click();
    dialog = page.getByRole("dialog", { name: "Manage Supabase" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(rowManageButton).toBeFocused();

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/${agent.id}/integrations`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("managed-mcp-provider-supabase")).toContainText("Available");
    const agentSupabaseCard = page.getByTestId("managed-mcp-provider-supabase");
    await agentSupabaseCard.getByRole("button", { name: "Set access for Supabase" }).click();
    dialog = page.getByRole("dialog", { name: "Manage Supabase access" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "No access" })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: "Read only", exact: true })).toBeEnabled();
    await expect(dialog.getByRole("radio", { name: "Read & write", exact: false })).toBeDisabled();
    await expect(dialog).toContainText("The organization connection is read only.");
    await dialog.getByRole("radio", { name: "Read only", exact: true }).check();
    await dialog.getByRole("button", { name: "Save" }).click();

    await expect(agentSupabaseCard).toContainText("Read only");
    await expect(agentSupabaseCard.getByRole("button", { name: "Manage Supabase" })).toBeVisible();
    expect(mock.getBinding(supabase.id)?.accessMode).toBe("read_only");
    const accessRequest = mock.requests.find((entry) =>
      entry.path.endsWith(`/mcp-connections/${supabase.id}`)
      && entry.method === "PUT");
    expect(accessRequest?.body).toMatchObject({
      accessMode: "read_only",
      status: "active",
    });
    expect(accessRequest?.body).not.toHaveProperty("enabledToolIds");

    await page.getByRole("tab", { name: "Manage", exact: true }).click();
    const managedSection = page.getByTestId("agent-managed-mcp-connections");
    await expect(managedSection).toBeVisible();
    const agentConnection = managedSection.getByTestId(`agent-mcp-connection-${supabase.id}`);
    await expect(agentConnection).toContainText("Read only");
    await expect(agentConnection.getByRole("checkbox")).toHaveCount(0);
    await expect(agentConnection.getByText("Tool allowlist")).toHaveCount(0);
    await expect(agentConnection.getByText(/external\.supabase\./)).toHaveCount(0);
    await agentConnection.getByRole("button", { name: "Manage" }).click();
    dialog = page.getByRole("dialog", { name: "Manage Supabase access" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Read only", exact: true })).toBeChecked();

    expect(mock.requests.some((entry) => entry.path.endsWith("/oauth/scopes"))).toBe(false);
    expect(mock.requests.some((entry) => entry.path.endsWith("/oauth/scope"))).toBe(false);
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
    await page.getByRole("tab", { name: "Manage", exact: true }).click();
    const connectionRow = page.getByTestId(`mcp-connection-${connection.id}`);
    await expect(connectionRow).toContainText("Real STDIO MCP");
    await expect(connectionRow).toContainText("Connected");

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/${agent.id}/integrations`, {
      waitUntil: "domcontentloaded",
    });
    const availableConnection = page.getByTestId(`agent-mcp-connection-${connection.id}`);
    await expect(availableConnection).toContainText("Real STDIO MCP");
    await expect(availableConnection).toContainText("No access");
    await availableConnection.getByRole("button", { name: "Set access" }).click();
    let accessDialog = page.getByRole("dialog", { name: "Manage Real STDIO MCP access" });
    await expect(accessDialog).toBeVisible();
    await expect(accessDialog.getByText("inspect", { exact: true })).toHaveCount(0);
    await expect(accessDialog.getByRole("checkbox")).toHaveCount(0);
    await accessDialog.getByRole("radio", { name: "Full server access" }).check();
    await accessDialog.getByRole("button", { name: "Save" }).click();
    await expect(accessDialog).toBeHidden();

    await page.getByRole("tab", { name: "Manage", exact: true }).click();
    const agentConnection = page.getByTestId(`agent-mcp-connection-${connection.id}`);
    await expect(agentConnection).toContainText("Full server access");
    await expect(agentConnection.getByText("Tool allowlist")).toHaveCount(0);
    await expect(agentConnection.getByRole("checkbox")).toHaveCount(0);
    await agentConnection.getByRole("button", { name: "Manage" }).click();
    accessDialog = page.getByRole("dialog", { name: "Manage Real STDIO MCP access" });
    await expect(accessDialog).toBeVisible();
    await expect(accessDialog.getByRole("radio", { name: "Full server access" })).toBeChecked();
    await expect(accessDialog.getByText("inspect", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    const bindingsResponse = await page.request.get(
      `${E2E_BASE_URL}/api/agents/${agent.id}/mcp-connections?orgId=${organization.id}`,
    );
    expect(bindingsResponse.ok()).toBe(true);
    const summaries = await bindingsResponse.json() as Array<{
      connection: { id: string };
      binding: {
        id: string;
        status: string;
        accessMode: string;
        policyRevision: number;
      } | null;
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
      contextSnapshot: {
        managedMcpPolicySnapshot: [{
          bindingId: summary!.binding!.id,
          serverName: "real-stdio-mcp",
          accessMode: summary!.binding!.accessMode,
          policyRevision: summary!.binding!.policyRevision,
          toolPolicy: {
            mode: "allowlist",
            allowedToolNames: summary!.tools.map((tool) => tool.rudderToolName),
          },
        }],
      },
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
