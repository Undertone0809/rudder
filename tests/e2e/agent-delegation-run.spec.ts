import { expect, test, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  buildMcpServerEnv,
  runAgentV1McpJsonRpcMessage,
} from "../../cli/src/agent-v1-mcp-server.ts";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  agentWakeupRequests,
  createDb,
  heartbeatRuns,
} from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import {
  E2E_BASE_URL,
  E2E_CODEX_STUB,
  E2E_DATABASE_URL,
} from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);
const RUN_TIMEOUT = 75_000;

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function createOrganization(request: APIRequestContext) {
  const response = await request.post("/api/orgs", {
    data: {
      name: `Delegation E2E ${Date.now()}`,
      requireBoardApprovalForNewAgents: false,
    },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ id: string }>;
}

async function createAgentKey(request: APIRequestContext, agentId: string) {
  const response = await request.post(`/api/agents/${agentId}/keys`, {
    data: { name: `delegation-e2e-${Date.now()}` },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ token: string }>;
}

function structuredContent(response: Awaited<ReturnType<typeof runAgentV1McpJsonRpcMessage>>) {
  expect(response?.result).toMatchObject({ isError: false });
  return response?.result?.structuredContent as Record<string, unknown>;
}

test("source Run creates and inspects an independent Delegation Run through MCP", async ({ page, request }) => {
  test.setTimeout(120_000);
  const organization = await createOrganization(request);
  const sourceAgent = await createE2EChatAgent(request, organization.id, {
    name: "Delegation Source",
    command: E2E_CODEX_STUB,
  }) as { id: string };
  const targetAgent = await createE2EChatAgent(request, organization.id, {
    name: "Delegation Target",
    command: E2E_CODEX_STUB,
  }) as { id: string };
  const sourceKey = await createAgentKey(request, sourceAgent.id);
  const sourceRunId = randomUUID();
  const startedAt = new Date();
  await e2eDb.insert(heartbeatRuns).values({
    id: sourceRunId,
    orgId: organization.id,
    agentId: sourceAgent.id,
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "running",
    startedAt,
    contextSnapshot: { scene: "heartbeat" },
    createdAt: startedAt,
    updatedAt: startedAt,
  });

  const env = buildMcpServerEnv({
    RUDDER_API_URL: E2E_BASE_URL,
    RUDDER_API_KEY: sourceKey.token,
    RUDDER_ORG_ID: organization.id,
    RUDDER_AGENT_ID: sourceAgent.id,
    RUDDER_RUN_ID: sourceRunId,
  });
  const task = "Inspect the delegated target and return a concise result.";
  const idempotencyKey = `delegation-e2e-${randomUUID()}`;
  const createResult = structuredContent(await runAgentV1McpJsonRpcMessage({
    jsonrpc: "2.0",
    id: "delegation-create",
    method: "tools/call",
    params: {
      name: "rudder_runs_create",
      arguments: { task, targetAgentId: targetAgent.id, idempotencyKey },
    },
  }, env));
  expect(createResult).toMatchObject({
    sourceRunId: expect.any(String),
    targetAgentId: expect.any(String),
    scene: "delegation",
    admissionStatus: "queued",
    replayed: false,
  });
  expect(createResult).not.toHaveProperty("run");

  const cancelSourceResult = structuredContent(await runAgentV1McpJsonRpcMessage({
    jsonrpc: "2.0",
    id: "delegation-cancel-source",
    method: "tools/call",
    params: { name: "rudder_runs_cancel", arguments: { run: sourceRunId } },
  }, env));
  expect(cancelSourceResult).toMatchObject({
    id: `run_${sourceRunId.slice(0, 8)}`,
    status: "cancelled",
  });

  let targetRunId: string | null = null;
  await expect.poll(async () => {
    const requestRow = await e2eDb
      .select({ runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.delegationIdempotencyKey, idempotencyKey))
      .then((rows) => rows[0] ?? null);
    targetRunId = requestRow?.runId ?? null;
    if (!targetRunId) return null;
    return e2eDb
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, targetRunId))
      .then((rows) => rows[0]?.status ?? null);
  }, { timeout: RUN_TIMEOUT }).toBe("succeeded");
  expect(targetRunId).toBeTruthy();

  const getResult = structuredContent(await runAgentV1McpJsonRpcMessage({
    jsonrpc: "2.0",
    id: "delegation-get",
    method: "tools/call",
    params: { name: "rudder_runs_get", arguments: { run: targetRunId } },
  }, env));
  expect(getResult).toMatchObject({
    id: expect.any(String),
    status: "succeeded",
    scene: "delegation",
    sourceRunId: expect.any(String),
  });
  expect(JSON.stringify(getResult)).not.toContain(task);

  const eventsResult = structuredContent(await runAgentV1McpJsonRpcMessage({
    jsonrpc: "2.0",
    id: "delegation-events",
    method: "tools/call",
    params: {
      name: "rudder_runs_events",
      arguments: { run: targetRunId, limit: 200 },
    },
  }, env));
  expect(Array.isArray(eventsResult.items)).toBe(true);
  expect((eventsResult.items as Array<{ eventType?: string }>).some((event) =>
    event.eventType === "adapter.invoke" || event.eventType === "transcript.entry"
  )).toBe(true);

  const transcriptResult = structuredContent(await runAgentV1McpJsonRpcMessage({
    jsonrpc: "2.0",
    id: "delegation-transcript",
    method: "tools/call",
    params: {
      name: "rudder_runs_transcript",
      arguments: { run: targetRunId, chronological: true, includeOutput: true },
    },
  }, env));
  expect(Array.isArray(transcriptResult.rows)).toBe(true);
  expect((transcriptResult.rows as unknown[]).length).toBeGreaterThan(0);

  const sourceAfterDelegation = await e2eDb
    .select({ status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, sourceRunId))
    .then((rows) => rows[0]);
  expect(sourceAfterDelegation?.status).toBe("cancelled");
  const sourceAgentRuns = await e2eDb
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.agentId, sourceAgent.id));
  expect(sourceAgentRuns).toEqual([{ id: sourceRunId }]);

  const listFixtureRunId = randomUUID();
  await e2eDb.insert(heartbeatRuns).values({
    id: listFixtureRunId,
    orgId: organization.id,
    agentId: targetAgent.id,
    invocationSource: "delegation",
    triggerDetail: "agent_run_created",
    status: "succeeded",
    sourceRunId,
    startedAt,
    finishedAt: new Date(),
    contextSnapshot: { scene: "delegation", sourceRunId },
    createdAt: startedAt,
    updatedAt: new Date(),
  });

  await page.addInitScript((orgId: string) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/agents/${targetAgent.id}/runs/${targetRunId}`, { waitUntil: "domcontentloaded" });
  const mainContent = page.locator("#main-content");
  await expect(mainContent.getByTestId("run-agent-run-facts").getByText("Delegation", { exact: true })).toBeVisible();
  await mainContent.getByTestId("agent-runs-history-trigger").click();
  const historyPopover = page.getByTestId("agent-runs-history-popover");
  await historyPopover.getByRole("button", { name: /^Filter/ }).click();
  const filterPopover = page.getByTestId("run-filter-popover");
  await expect(filterPopover.getByTestId("run-filter-scene-section").getByRole("button", { name: "Delegation" })).toBeVisible();
  await page.screenshot({ path: "/tmp/r6z-155-delegation-filter.png", fullPage: true });

  const failedDelegationRunId = randomUUID();
  const failedAt = new Date();
  await e2eDb.insert(heartbeatRuns).values({
    id: failedDelegationRunId,
    orgId: organization.id,
    agentId: targetAgent.id,
    invocationSource: "delegation",
    triggerDetail: "agent_run_created",
    status: "failed",
    sourceRunId,
    startedAt: failedAt,
    finishedAt: failedAt,
    error: "Synthetic retry fixture",
    contextSnapshot: {
      scene: "delegation",
      rudderScene: "delegation",
      sourceRunId,
      sourceAgentId: sourceAgent.id,
      targetAgentId: targetAgent.id,
      delegationTask: "Retry this bounded delegated task.",
      forceFreshSession: true,
    },
    createdAt: failedAt,
    updatedAt: failedAt,
  });
  const retryResult = structuredContent(await runAgentV1McpJsonRpcMessage({
    jsonrpc: "2.0",
    id: "delegation-retry",
    method: "tools/call",
    params: { name: "rudder_runs_retry", arguments: { run: failedDelegationRunId } },
  }, env));
  expect(retryResult).toMatchObject({
    id: expect.any(String),
    retryOfRunId: failedDelegationRunId.replaceAll("-", "").slice(0, 12),
    sourceRunId: sourceRunId.replaceAll("-", "").slice(0, 12),
  });
  await expect.poll(async () => e2eDb
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      invocationSource: heartbeatRuns.invocationSource,
      sourceRunId: heartbeatRuns.sourceRunId,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.retryOfRunId, failedDelegationRunId))
    .then((rows) => rows[0] ?? null), { timeout: RUN_TIMEOUT }).toMatchObject({
    id: expect.any(String),
    status: "succeeded",
    invocationSource: "delegation",
    sourceRunId,
  });
});
