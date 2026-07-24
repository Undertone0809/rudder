import { describe, expect, it, vi } from "vitest";
import {
  buildCustomMcpPayload,
  canReconnectManagedMcp,
  defaultCustomMcpForm,
  reserveAuthorizationLauncher,
} from "./OrganizationMcpSettings";

describe("managed MCP authorization launcher", () => {
  it("uses the existing Desktop external-navigation bridge without opening a popup", async () => {
    const openExternal = vi.fn(async () => undefined);
    const forceOpenExternal = vi.fn(async () => undefined);
    const openWindow = vi.fn<typeof window.open>(() => null);
    const launcher = reserveAuthorizationLauncher({
      desktopShell: { openExternal, forceOpenExternal },
      openWindow,
    });

    await launcher.navigate("https://oauth.example.test/authorize");

    expect(openWindow).not.toHaveBeenCalled();
    expect(forceOpenExternal).toHaveBeenCalledWith("https://oauth.example.test/authorize");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("falls back to the standard Desktop external-navigation bridge", async () => {
    const openExternal = vi.fn(async () => undefined);
    const launcher = reserveAuthorizationLauncher({
      desktopShell: { openExternal },
      openWindow: vi.fn<typeof window.open>(() => null),
    });

    await launcher.navigate("https://oauth.example.test/authorize");

    expect(openExternal).toHaveBeenCalledWith("https://oauth.example.test/authorize");
  });

  it("keeps synchronous popup reservation for the browser flow", async () => {
    const replace = vi.fn();
    const close = vi.fn();
    const reservedWindow = {
      opener: null,
      location: { replace },
      close,
    } as unknown as Window;
    const openWindow = vi.fn<typeof window.open>(() => reservedWindow);
    const launcher = reserveAuthorizationLauncher({
      desktopShell: null,
      openWindow,
    });

    await launcher.navigate("https://oauth.example.test/authorize");
    launcher.close();

    expect(openWindow).toHaveBeenCalledWith("about:blank", "_blank");
    expect(replace).toHaveBeenCalledWith("https://oauth.example.test/authorize");
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not create a browser launcher when popup reservation is rejected", async () => {
    expect(() => reserveAuthorizationLauncher({
      desktopShell: null,
      openWindow: () => null,
    })).toThrow("Allow pop-ups for Rudder, then try again");
  });
});

describe("managed MCP authorization recovery", () => {
  it("allows an authorizing connection to restart OAuth when external navigation failed", () => {
    expect(canReconnectManagedMcp("authorizing")).toBe(true);
  });
});

describe("custom MCP connection form", () => {
  it("stores every literal HTTP header as encrypted credential material", () => {
    const form = defaultCustomMcpForm();
    form.displayName = "Release MCP";
    form.url = "https://mcp.example.com/mcp";
    form.headers = [
      { id: "1", key: "X-Workspace", value: "docs" },
      { id: "2", key: "Authorization", value: "Bearer secret-token" },
      { id: "4", key: "X-Access-Token", value: "secondary-secret" },
      { id: "5", key: "X-Client-Key", value: "client-secret" },
    ];
    form.headersFromEnvironment = [
      { id: "3", key: "X-Region", value: "MCP_REGION" },
    ];
    form.toolAllowlistText = "search, list_documents";
    form.toolDenylistText = "delete_document";

    const payload = buildCustomMcpPayload(form);

    expect(payload).toMatchObject({
      provider: "custom",
      transport: "streamable_http",
      safeConfig: {
        url: "https://mcp.example.com/mcp",
        headersFromEnv: { "X-Region": "MCP_REGION" },
        secretHeaderNames: [
          "X-Workspace",
          "Authorization",
          "X-Access-Token",
          "X-Client-Key",
        ],
        toolAllowlist: ["search", "list_documents"],
        toolDenylist: ["delete_document"],
      },
      secrets: {
        headers: {
          "X-Workspace": "docs",
          Authorization: "Bearer secret-token",
          "X-Access-Token": "secondary-secret",
          "X-Client-Key": "client-secret",
        },
      },
      startupTimeoutMs: 10_000,
      toolTimeoutMs: 60_000,
    });
    expect(JSON.stringify(payload.safeConfig)).not.toContain("secret-token");
    expect(JSON.stringify(payload.safeConfig)).not.toContain("secondary-secret");
    expect(JSON.stringify(payload.safeConfig)).not.toContain("client-secret");
  });

  it("stores STDIO values as secrets and keeps only names in safe config", () => {
    const form = defaultCustomMcpForm();
    form.displayName = "Local database";
    form.transport = "stdio";
    form.command = "npx";
    form.arguments = [
      { id: "1", value: "-y" },
      { id: "2", value: "@example/mcp-server,with-comma" },
    ];
    form.cwd = "/workspace";
    form.environment = [{ id: "1", key: "DATABASE_URL", value: "postgres://secret" }];
    form.forwardedEnvText = "PATH, NODE_EXTRA_CA_CERTS";

    const payload = buildCustomMcpPayload(form);

    expect(payload).toMatchObject({
      provider: "custom",
      transport: "stdio",
      safeConfig: {
        command: "npx",
        args: ["-y", "@example/mcp-server,with-comma"],
        cwd: "/workspace",
        forwardedEnv: ["PATH", "NODE_EXTRA_CA_CERTS"],
        secretEnvNames: ["DATABASE_URL"],
      },
      secrets: {
        env: { DATABASE_URL: "postgres://secret" },
      },
    });
    expect(JSON.stringify(payload.safeConfig)).not.toContain("postgres://secret");
  });

  it("rejects conflicting Authorization sources before sending the request", () => {
    const form = defaultCustomMcpForm();
    form.displayName = "Conflicting auth";
    form.url = "https://mcp.example.com/mcp";
    form.bearerTokenEnvVar = "MCP_TOKEN";
    form.headers = [{ id: "1", key: "Authorization", value: "Bearer secret" }];

    expect(() => buildCustomMcpPayload(form)).toThrow(/only one Authorization or Bearer/i);
  });
});
