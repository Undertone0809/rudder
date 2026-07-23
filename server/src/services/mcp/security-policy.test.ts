import { describe, expect, it, vi } from "vitest";
import {
  assertSafeMcpHeaders,
  parseMcpDeploymentPolicyEnv,
  resolveMcpHttpTarget,
  validateMcpStdioPolicy,
} from "./security-policy.js";

describe("managed MCP deployment policy", () => {
  it("parses instance-admin allowlists from dedicated environment fields", () => {
    expect(parseMcpDeploymentPolicyEnv({
      RUDDER_MCP_HTTP_ALLOWLIST: "http://127.0.0.1:7788, https://internal.example",
      RUDDER_MCP_STDIO_EXECUTABLE_ALLOWLIST: "/usr/local/bin/acme-mcp,node",
      RUDDER_MCP_STDIO_CWD_ALLOWLIST: "/srv/mcp,/opt/mcp",
      RUDDER_MCP_STDIO_ENV_ALLOWLIST: "SAFE_TOKEN,READ_ONLY_FLAG",
    })).toEqual({
      httpOrigins: ["http://127.0.0.1:7788", "https://internal.example"],
      stdioExecutables: ["/usr/local/bin/acme-mcp", "node"],
      stdioWorkingDirectories: ["/srv/mcp", "/opt/mcp"],
      stdioEnvironmentNames: ["SAFE_TOKEN", "READ_ONLY_FLAG"],
    });
  });

  it("allows arbitrary STDIO only for local trusted deployments", () => {
    expect(() => validateMcpStdioPolicy({
      command: "arbitrary-command",
      cwd: "/anywhere",
      environmentNames: ["ANY_SECRET"],
    }, {
      deploymentMode: "local_trusted",
      stdioExecutables: [],
      stdioWorkingDirectories: [],
      stdioEnvironmentNames: [],
    })).not.toThrow();

    expect(() => validateMcpStdioPolicy({
      command: "/usr/local/bin/acme-mcp",
      cwd: "/srv/mcp",
      environmentNames: ["SAFE_TOKEN"],
    }, {
      deploymentMode: "authenticated",
      stdioExecutables: ["/usr/local/bin/acme-mcp"],
      stdioWorkingDirectories: ["/srv/mcp"],
      stdioEnvironmentNames: ["SAFE_TOKEN"],
    })).not.toThrow();

    expect(() => validateMcpStdioPolicy({
      command: "/bin/sh",
      cwd: "/srv/mcp",
      environmentNames: ["SAFE_TOKEN"],
    }, {
      deploymentMode: "authenticated",
      stdioExecutables: ["/usr/local/bin/acme-mcp"],
      stdioWorkingDirectories: ["/srv/mcp"],
      stdioEnvironmentNames: ["SAFE_TOKEN"],
    })).toThrow(/executable/i);
  });
});

describe("managed MCP outbound target policy", () => {
  it("permits public HTTPS and pins the validated address with SNI and Host metadata", async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 as const },
    ]);

    await expect(resolveMcpHttpTarget("https://mcp.example/tools", {
      lookup,
      allowedOrigins: [],
    })).resolves.toMatchObject({
      url: new URL("https://mcp.example/tools"),
      resolvedAddress: "93.184.216.34",
      hostHeader: "mcp.example",
      tlsServername: "mcp.example",
    });
  });

  it("rejects mixed public/private DNS answers instead of filtering to the public result", async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 as const },
      { address: "127.0.0.1", family: 4 as const },
    ]);

    await expect(resolveMcpHttpTarget("https://rebind.example/mcp", {
      lookup,
      allowedOrigins: [],
    })).rejects.toThrow(/blocked network address/i);
  });

  it("rejects HTTP, localhost, private targets, userinfo, and fragments without an exact origin allowlist", async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: "127.0.0.1", family: 4 as const },
    ]);

    for (const value of [
      "http://127.0.0.1:7788/mcp",
      "https://localhost/mcp",
      "https://user:password@example.com/mcp",
      "https://example.com/mcp#secret",
    ]) {
      await expect(resolveMcpHttpTarget(value, {
        lookup,
        allowedOrigins: [],
      })).rejects.toThrow();
    }

    await expect(resolveMcpHttpTarget("http://127.0.0.1:7788/mcp", {
      lookup,
      allowedOrigins: ["http://127.0.0.1:7788"],
    })).resolves.toMatchObject({ resolvedAddress: "127.0.0.1" });
  });

  it("pins curated provider origins and rejects a mismatched registry URL before DNS", async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 as const },
    ]);

    await expect(resolveMcpHttpTarget("https://attacker.example/mcp", {
      lookup,
      allowedOrigins: [],
      curatedOrigin: "https://mcp.notion.com",
    })).rejects.toThrow(/curated/i);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("managed MCP header policy", () => {
  it("rejects hop-by-hop, routing, cookie, forwarding, framing, and authorization headers", () => {
    for (const name of [
      "Host",
      "Connection",
      "Proxy-Authorization",
      "Forwarded",
      "X-Forwarded-For",
      "Cookie",
      "Content-Length",
      "Transfer-Encoding",
      "Authorization",
    ]) {
      expect(() => assertSafeMcpHeaders({ [name]: "secret-value" })).toThrow(/header/i);
    }
  });

  it("never includes a rejected header value in its public error", () => {
    expect(() => assertSafeMcpHeaders({
      Authorization: "Bearer super-secret-value",
    })).toThrowError(expect.not.stringContaining("super-secret-value"));
  });
});
