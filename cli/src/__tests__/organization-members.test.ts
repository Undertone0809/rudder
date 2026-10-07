import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMcpServerEnv,
  runAgentV1McpJsonRpcMessage,
} from "../agent-v1-mcp-server.js";
import { runCli } from "../program.js";

const seededOrganizationId = "org-seeded";
const seededAgentId = "11111111-1111-4111-8111-111111111111";
const seededAgentToken = "seeded-directory-agent-key";
const seededDirectory = [
  { orgId: seededOrganizationId, name: "Ada Lovelace", type: "human", role: "operator", ref: "usr_14ff96a7", active: true },
  { orgId: seededOrganizationId, name: "Ada Byron", type: "human", role: "operator", ref: "usr_24ff96a7", active: true },
  { orgId: seededOrganizationId, name: "Ada Agent", type: "agent", role: "builder", ref: "agt_34ff96a7", active: true },
  { orgId: seededOrganizationId, name: "Ada Inactive", type: "human", role: "operator", ref: "usr_44ff96a7", active: false },
  { orgId: "org-foreign", name: "Ada Foreign", type: "human", role: "operator", ref: "usr_54ff96a7", active: true },
];
const secondPageCursor = "fixture/page?2";

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function createSeededDirectoryServer(observations: Array<Record<string, unknown>>) {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const match = url.pathname.match(/^\/api\/orgs\/([^/]+)\/members\/directory$/u);
    if (!match) return writeJson(response, 404, { error: "not_found" });
    const orgId = decodeURIComponent(match[1]!);
    observations.push({
      method: request.method,
      orgId,
      authorization: request.headers.authorization,
      query: Object.fromEntries(url.searchParams),
    });
    if (request.method !== "GET") return writeJson(response, 405, { error: "method_not_allowed" });
    if (request.headers.authorization !== `Bearer ${seededAgentToken}`) {
      return writeJson(response, 401, { error: "unauthorized" });
    }
    if (orgId !== seededOrganizationId) return writeJson(response, 403, { error: "organization_forbidden" });

    const query = (url.searchParams.get("query") ?? "").toLocaleLowerCase();
    const type = url.searchParams.get("type") ?? "all";
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const cursor = url.searchParams.get("cursor");
    const offset = cursor === secondPageCursor ? 1 : cursor ? -1 : 0;
    if (offset < 0 || !Number.isInteger(limit) || limit < 1) {
      return writeJson(response, 400, { error: "invalid_page" });
    }

    const matching = seededDirectory.filter((row) => row.orgId === orgId && row.active
      && (type === "all" || row.type === type)
      && row.name.toLocaleLowerCase().includes(query));
    const items = matching.slice(offset, offset + limit).map(({ name, type: memberType, role, ref }) => ({
      name,
      type: memberType,
      role,
      ref,
    }));
    const nextOffset = offset + items.length;
    return writeJson(response, 200, {
      total: matching.length,
      items,
      nextCursor: nextOffset < matching.length ? secondPageCursor : null,
      hasMore: nextOffset < matching.length,
    });
  });
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function outputJsonPage(calls: readonly (readonly unknown[])[]) {
  const output = calls.map((call) => String(call[0])).join("");
  return JSON.parse(output) as Record<string, unknown>;
}

describe("organization members command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves member UUID refs when --full-ids is requested", async () => {
    const agentId = "d573266f-af95-44e6-9303-e903a54662b8";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/orgs/org-1/members/directory");
      expect(url.searchParams.get("fullIds")).toBe("true");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-1");
      return new Response(JSON.stringify({
        total: 1,
        items: [{ name: "Ada", type: "agent", role: "builder", ref: agentId }],
        nextCursor: null,
        hasMore: false,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runCli([
      process.execPath,
      "rudder",
      "org",
      "members",
      "--org-id",
      "org-1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-1",
      "--json",
      "--full-ids",
    ])).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const output = stdout.mock.calls.map((call) => String(call[0])).join("");
    expect(JSON.parse(output)).toEqual({
      total: 1,
      items: [{ name: "Ada", type: "agent", role: "builder", ref: agentId }],
      nextCursor: null,
      hasMore: false,
    });
  });

  it("uses the authenticated cursor to fetch the next short-reference page", async () => {
    const firstPage = {
      total: 3,
      items: [
        { name: "Ada", type: "agent", role: "builder", ref: "agt_12345678" },
        { name: "Grace", type: "agent", role: "builder", ref: "agt_23456789" },
      ],
      nextCursor: "next/page?token=1",
      hasMore: true,
    };
    const secondPage = {
      total: 3,
      items: [{ name: "Linus", type: "agent", role: "builder", ref: "agt_34567890" }],
      nextCursor: null,
      hasMore: false,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/orgs/org-1/members/directory");
      expect(url.searchParams.get("query")).toBe("builder");
      expect(url.searchParams.get("type")).toBe("agent");
      expect(url.searchParams.get("limit")).toBe("2");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-2");
      return new Response(JSON.stringify(url.searchParams.has("cursor") ? secondPage : firstPage), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runCli([
      process.execPath,
      "rudder",
      "org",
      "members",
      "--org-id",
      "org-1",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-2",
      "--query",
      "builder",
      "--type",
      "agent",
      "--limit",
      "2",
      "--cursor",
      firstPage.nextCursor!,
      "--json",
    ])).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const output = JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join(""));
    expect(output).toEqual(secondPage);
    expect(output.items[0].ref).toMatch(/^agt_[a-z0-9]{8,}$/u);
    expect(output.items[0].ref).not.toMatch(/^[0-9a-f-]{36}$/iu);
  });

  it("keeps authenticated CLI and MCP reads in parity against seeded organization data", async () => {
    const observations: Array<Record<string, unknown>> = [];
    const server = createSeededDirectoryServer(observations);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Seeded directory fixture did not bind a TCP port");
    const apiBase = `http://127.0.0.1:${address.port}`;
    const priorAgentId = process.env.RUDDER_AGENT_ID;
    process.env.RUDDER_AGENT_ID = seededAgentId;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const runCliPage = async (cursor?: string) => {
      stdout.mockClear();
      await expect(runCli([
        process.execPath,
        "rudder",
        "org",
        "members",
        "--org-id",
        seededOrganizationId,
        "--api-base",
        apiBase,
        "--api-key",
        seededAgentToken,
        "--query",
        "Ada",
        "--type",
        "human",
        "--limit",
        "1",
        ...(cursor ? ["--cursor", cursor] : []),
        "--json",
      ])).resolves.toBe(0);
      return outputJsonPage(stdout.mock.calls);
    };

    const runMcpPage = async (cursor?: string) => {
      const response = await runAgentV1McpJsonRpcMessage({
        jsonrpc: "2.0",
        id: cursor ? "organization-members-next" : "organization-members-first",
        method: "tools/call",
        params: {
          name: "rudder_organization_members_list",
          arguments: { query: "Ada", type: "human", limit: 1, ...(cursor ? { cursor } : {}) },
        },
      }, buildMcpServerEnv({
        RUDDER_API_URL: apiBase,
        RUDDER_API_KEY: seededAgentToken,
        RUDDER_ORG_ID: seededOrganizationId,
        RUDDER_AGENT_ID: seededAgentId,
      }));
      expect(response?.result).toMatchObject({ isError: false });
      const result = response?.result;
      if (!result || typeof result !== "object" || !("structuredContent" in result)) return null;
      return result.structuredContent as Record<string, unknown>;
    };

    try {
      const cliFirst = await runCliPage();
      const mcpFirst = await runMcpPage();
      expect(cliFirst).toEqual(mcpFirst);
      expect(cliFirst).toMatchObject({
        total: 2,
        items: [{ name: "Ada Lovelace", type: "human", role: "operator", ref: "usr_14ff96a7" }],
        nextCursor: secondPageCursor,
        hasMore: true,
      });

      const cliSecond = await runCliPage(secondPageCursor);
      const mcpSecond = await runMcpPage(secondPageCursor);
      expect(cliSecond).toEqual(mcpSecond);
      expect(cliSecond).toMatchObject({
        total: 2,
        items: [{ name: "Ada Byron", type: "human", role: "operator", ref: "usr_24ff96a7" }],
        nextCursor: null,
        hasMore: false,
      });

      const foreignOrganization = await fetch(`${apiBase}/api/orgs/org-foreign/members/directory`, {
        headers: { authorization: `Bearer ${seededAgentToken}` },
      });
      expect(foreignOrganization.status).toBe(403);
      expect(await foreignOrganization.json()).toEqual({ error: "organization_forbidden" });
      expect(observations).toHaveLength(5);
      expect(observations.slice(0, 4)).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: "GET", orgId: seededOrganizationId, authorization: `Bearer ${seededAgentToken}` }),
      ]));
      expect(observations.slice(0, 4).every((observation) => (
        observation.method === "GET"
        && observation.orgId === seededOrganizationId
        && observation.authorization === `Bearer ${seededAgentToken}`
      ))).toBe(true);
      const clientQueries = observations.slice(0, 4).map((observation) => observation.query);
      expect(clientQueries.filter((query) => (
        query !== null && typeof query === "object" && "cursor" in query
      ))).toHaveLength(2);
      expect(clientQueries).toEqual(expect.arrayContaining([
        expect.objectContaining({ query: "Ada", type: "human", limit: "1" }),
        expect.objectContaining({ query: "Ada", type: "human", limit: "1", cursor: secondPageCursor }),
      ]));
      expect(observations[4]).toMatchObject({ method: "GET", orgId: "org-foreign" });
      expect(JSON.stringify([cliFirst, cliSecond, mcpFirst, mcpSecond])).not.toContain("Ada Foreign");
      expect(JSON.stringify([cliFirst, cliSecond, mcpFirst, mcpSecond])).not.toContain("Ada Inactive");
    } finally {
      if (priorAgentId === undefined) delete process.env.RUDDER_AGENT_ID;
      else process.env.RUDDER_AGENT_ID = priorAgentId;
      await closeServer(server);
    }
  });
});
