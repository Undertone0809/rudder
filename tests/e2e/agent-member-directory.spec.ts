import { expect, test, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { buildMcpServerEnv, runAgentV1McpJsonRpcMessage } from "../../cli/src/agent-v1-mcp-server.ts";
import { and, eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  agents as agentsTable,
  authUsers,
  createDb,
  operatorProfiles,
  organizationMemberships,
} from "../../packages/db/src/index.ts";
import { E2E_BASE_URL, E2E_DATABASE_URL, E2E_HOME } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

type Organization = { id: string; name: string };
type Agent = { id: string; name: string };
type MemberPage = {
  total: number;
  items: Array<{ name: string; type: "human" | "agent"; role: string; ref: string }>;
  nextCursor: string | null;
  hasMore: boolean;
};

async function createOrganization(request: APIRequestContext, name: string) {
  const response = await request.post("/api/orgs", {
    data: { name, requireBoardApprovalForNewAgents: false },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Organization>;
}

async function createAgent(request: APIRequestContext, orgId: string, name: string) {
  const response = await request.post(`/api/orgs/${orgId}/agents`, {
    data: {
      name,
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.4" },
    },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Agent>;
}

async function createAgentKey(request: APIRequestContext, agentId: string) {
  const response = await request.post(`/api/agents/${agentId}/keys`, {
    data: { name: `member-directory-${Date.now()}` },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ token: string }>;
}

test("agent member directory keeps org scope, short refs, pagination, and MCP access", async ({ page }) => {
  const organization = await createOrganization(page.request, `Member Directory ${Date.now()}`);
  const firstAgent = await createAgent(page.request, organization.id, "Directory Agent 1");
  const key = await createAgentKey(page.request, firstAgent.id);

  const agentHeaders = { authorization: `Bearer ${key.token}` };
  const smallResponse = await page.request.get(`/api/orgs/${organization.id}/members/directory?limit=1`, {
    headers: agentHeaders,
  });
  expect(smallResponse.ok()).toBe(true);
  const smallPage = await smallResponse.json() as MemberPage;
  expect(smallPage.total).toBeGreaterThanOrEqual(1);
  expect(smallPage.items).toHaveLength(1);
  expect(smallPage.items[0]?.ref).toMatch(/^(agt|usr)_[a-z0-9]{8,}$/);
  expect(JSON.stringify(smallPage)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  const debugResponse = await page.request.get(`/api/orgs/${organization.id}/members/directory?limit=1&fullIds=true`, {
    headers: agentHeaders,
  });
  expect(debugResponse.ok()).toBe(true);
  const debugPage = await debugResponse.json() as MemberPage;
  expect(debugPage.items[0]?.ref).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  for (let index = 2; index <= 11; index += 1) {
    await createAgent(page.request, organization.id, `Directory Agent ${index}`);
  }

  const largeResponse = await page.request.get(`/api/orgs/${organization.id}/members/directory?limit=2`, {
    headers: agentHeaders,
  });
  expect(largeResponse.ok()).toBe(true);
  const largePage = await largeResponse.json() as MemberPage;
  expect(largePage.total).toBeGreaterThanOrEqual(11);
  expect(largePage.items).toHaveLength(2);
  expect(largePage.hasMore).toBe(true);
  expect(largePage.nextCursor).toBeTruthy();

  const mcpResponse = await runAgentV1McpJsonRpcMessage({
    jsonrpc: "2.0",
    id: "member-directory-e2e",
    method: "tools/call",
    params: {
      name: "rudder_organization_members_list",
      arguments: { query: "Directory Agent 11", type: "agent", limit: 5 },
    },
  }, buildMcpServerEnv({
    RUDDER_API_URL: E2E_BASE_URL,
    RUDDER_API_KEY: key.token,
    RUDDER_ORG_ID: organization.id,
    RUDDER_AGENT_ID: firstAgent.id,
  }));
  expect(mcpResponse?.result).toMatchObject({
    isError: false,
    structuredContent: {
      total: 1,
      items: [{ name: "Directory Agent 11", type: "agent", ref: expect.stringMatching(/^agt_/) }],
    },
  });

  const foreignOrganization = await createOrganization(page.request, `Foreign Directory ${Date.now()}`);
  const foreignResponse = await page.request.get(`/api/orgs/${foreignOrganization.id}/members/directory`, {
    headers: agentHeaders,
  });
  expect(foreignResponse.status()).toBe(403);
});

test("agent startup context shows mixed members and switches to MCP guidance at ten", async ({ page }) => {
  const organization = await createOrganization(page.request, `Member Startup ${Date.now()}`);
  const capturePath = `${E2E_HOME}/member-startup-context-${randomUUID()}.jsonl`;
  const captureCommandPath = `${E2E_HOME}/member-startup-capture-${randomUUID()}`;
  const captureScript = `#!/usr/bin/env node
    import fs from "node:fs";
    import path from "node:path";
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      fs.mkdirSync(path.dirname(${JSON.stringify(capturePath)}), { recursive: true });
      fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify(input) + "\\n", "utf8");
      process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "member-startup-e2e", model: "gpt-5.4" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "captured" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }) + "\\n");
    });
  `;
  await writeFile(captureCommandPath, captureScript, "utf8");
  await chmod(captureCommandPath, 0o755);
  const firstAgent = await createAgent(page.request, organization.id, "Startup Agent");
  const firstAgentUpdate = await e2eDb.update(agentsTable).set({
    agentRuntimeConfig: { command: captureCommandPath, model: "gpt-5.4" },
  }).where(eq(agentsTable.id, firstAgent.id));
  expect(firstAgentUpdate).toBeTruthy();
  const key = await createAgentKey(page.request, firstAgent.id);
  const agentHeaders = { authorization: `Bearer ${key.token}` };

  const humanId = `member-human-${randomUUID()}`;
  await e2eDb.insert(authUsers).values({
    id: humanId,
    name: "Human Auth Name",
    email: `${humanId}@example.test`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await e2eDb.insert(operatorProfiles).values({ userId: humanId, nickname: "Ada" });
  await e2eDb.insert(organizationMemberships).values({
    orgId: organization.id,
    principalType: "user",
    principalId: humanId,
    status: "active",
    membershipRole: "operator",
  });

  const hiddenAgent = await createAgent(page.request, organization.id, "Hidden Startup Agent");
  const suspendedAgent = await createAgent(page.request, organization.id, "Suspended Startup Agent");
  const pendingAgent = await createAgent(page.request, organization.id, "Pending Startup Agent");
  await e2eDb.update(agentsTable).set({ metadata: { hidden: true } }).where(eq(agentsTable.id, hiddenAgent.id));
  await e2eDb.update(agentsTable).set({ status: "suspended" }).where(eq(agentsTable.id, suspendedAgent.id));
  await e2eDb.update(organizationMemberships).set({ status: "pending" }).where(and(
    eq(organizationMemberships.orgId, organization.id),
    eq(organizationMemberships.principalType, "agent"),
    eq(organizationMemberships.principalId, pendingAgent.id),
  ));

  const invoke = async () => {
    const response = await page.request.post(`/api/agents/${firstAgent.id}/heartbeat/invoke?orgId=${organization.id}`, {
      headers: agentHeaders,
    });
    expect(response.ok()).toBe(true);
  };
  const readCaptures = async () => {
    try {
      return (await readFile(capturePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string);
    } catch {
      return [] as string[];
    }
  };

  await invoke();
  await expect.poll(async () => (await readCaptures()).length, { timeout: 45_000 }).toBe(1);
  const smallStartup = (await readCaptures())[0] ?? "";
  expect(smallStartup).toContain("#### organization members");
  expect(smallStartup).toContain("| Ada | human | operator | `usr_");
  expect(smallStartup).toContain("| Startup Agent | agent | engineer | `agt_");
  expect(smallStartup).not.toContain("Hidden Startup Agent");
  expect(smallStartup).not.toContain("Suspended Startup Agent");
  expect(smallStartup).not.toContain("Pending Startup Agent");
  expect(smallStartup).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);

  for (let index = 1; index <= 9; index += 1) {
    await createAgent(page.request, organization.id, `Visible Startup Agent ${index}`);
  }
  const activeDirectoryResponse = await page.request.get(`/api/orgs/${organization.id}/members/directory`, {
    headers: agentHeaders,
  });
  expect(activeDirectoryResponse.ok()).toBe(true);
  const activeDirectory = await activeDirectoryResponse.json() as MemberPage;
  expect(activeDirectory.total).toBeGreaterThanOrEqual(10);
  await invoke();
  await expect.poll(async () => (await readCaptures()).length, { timeout: 45_000 }).toBe(2);
  const largeStartup = (await readCaptures())[1] ?? "";
  expect(largeStartup).toContain(`Organization has ${activeDirectory.total} active members.`);
  expect(largeStartup).toContain("Use `rudder_organization_members_list` to query the member directory.");
  expect(largeStartup).toContain("CLI fallback: `rudder org members --org-id <id>`.");
  expect(largeStartup).not.toContain("| Ada | human | operator |");
});
