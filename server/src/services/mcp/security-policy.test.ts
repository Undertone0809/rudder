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
      RUDDER_MCP_STDIO_COMMAND_ALLOWLIST:
        ' [["/usr/local/bin/acme-mcp","--stdio"],["/usr/local/bin/node","/opt/mcp/server.mjs"]] ',
      RUDDER_MCP_STDIO_CWD_ALLOWLIST: "/srv/mcp,/opt/mcp",
      RUDDER_MCP_STDIO_ENV_ALLOWLIST: "SAFE_TOKEN,READ_ONLY_FLAG",
    })).toEqual({
      httpOrigins: ["http://127.0.0.1:7788", "https://internal.example"],
      stdioCommands: [
        ["/usr/local/bin/acme-mcp", "--stdio"],
        ["/usr/local/bin/node", "/opt/mcp/server.mjs"],
      ],
      stdioWorkingDirectories: ["/srv/mcp", "/opt/mcp"],
      stdioEnvironmentNames: ["SAFE_TOKEN", "READ_ONLY_FLAG"],
    });
  });

  it("allows arbitrary STDIO only for local trusted deployments", async () => {
    await expect(validateMcpStdioPolicy({
      command: "arbitrary-command",
      args: ["-e", "arbitrary-code"],
      cwd: "/anywhere",
      environmentNames: ["ANY_SECRET"],
    }, {
      deploymentMode: "local_trusted",
      stdioCommands: [],
      stdioWorkingDirectories: [],
      stdioEnvironmentNames: [],
    })).resolves.toBeUndefined();

    await expect(validateMcpStdioPolicy({
      command: "/usr/local/bin/acme-mcp",
      args: ["--stdio"],
      cwd: "/srv/mcp",
      environmentNames: ["SAFE_TOKEN"],
    }, {
      deploymentMode: "authenticated",
      stdioCommands: [["/usr/local/bin/acme-mcp", "--stdio"]],
      stdioWorkingDirectories: ["/srv/mcp"],
      stdioEnvironmentNames: ["SAFE_TOKEN"],
    }, {
      realpath: async (value) => value,
    })).resolves.toBeUndefined();

    await expect(validateMcpStdioPolicy({
      command: "/usr/local/bin/acme-mcp",
      args: ["--stdio", "--exec", "arbitrary-code"],
      cwd: "/srv/mcp",
      environmentNames: ["SAFE_TOKEN"],
    }, {
      deploymentMode: "authenticated",
      stdioCommands: [["/usr/local/bin/acme-mcp", "--stdio"]],
      stdioWorkingDirectories: ["/srv/mcp"],
      stdioEnvironmentNames: ["SAFE_TOKEN"],
    }, {
      realpath: async (value) => value,
    })).rejects.toThrow(/command/i);
  });

  it("requires authenticated commands to use absolute real paths for executable and cwd", async () => {
    const aliases = new Map([
      ["/allowed/acme", "/opt/bin/acme"],
      ["/requested/acme", "/opt/bin/acme"],
      ["/allowed/workspace", "/srv/real-workspace"],
      ["/requested/workspace", "/srv/real-workspace"],
    ]);
    const realpath = async (value: string) => aliases.get(value) ?? value;

    await expect(validateMcpStdioPolicy({
      command: "/requested/acme",
      args: ["--stdio"],
      cwd: "/requested/workspace",
      environmentNames: [],
    }, {
      deploymentMode: "authenticated",
      stdioCommands: [["/allowed/acme", "--stdio"]],
      stdioWorkingDirectories: ["/allowed/workspace"],
      stdioEnvironmentNames: [],
    }, { realpath })).resolves.toBeUndefined();

    await expect(validateMcpStdioPolicy({
      command: "node",
      args: ["/opt/mcp/server.mjs"],
      cwd: "/requested/workspace",
      environmentNames: [],
    }, {
      deploymentMode: "authenticated",
      stdioCommands: [["/usr/local/bin/node", "/opt/mcp/server.mjs"]],
      stdioWorkingDirectories: ["/allowed/workspace"],
      stdioEnvironmentNames: [],
    }, { realpath })).rejects.toThrow(/absolute/i);
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

  it("rejects non-IP and address-family-mismatched DNS answers even for allowlisted origins", async () => {
    for (const answer of [
      { address: "localhost", family: 4 as const },
      { address: "127.0.0.1", family: 6 as const },
    ]) {
      await expect(resolveMcpHttpTarget("http://internal.example/mcp", {
        lookup: async () => [answer],
        allowedOrigins: ["http://internal.example"],
      })).rejects.toThrow(/DNS answer/i);
    }
  });

  it("blocks NAT64 and IPv4-compatible address encodings of private targets", async () => {
    for (const address of [
      "64:ff9b::7f00:1",
      "64:ff9b:1::7f00:1",
      "::7f00:1",
      "2002:7f00:1::",
    ]) {
      await expect(resolveMcpHttpTarget("https://encoded.example/mcp", {
        lookup: async () => [{ address, family: 6 }],
        allowedOrigins: [],
      })).rejects.toThrow(/blocked network address/i);
    }
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
