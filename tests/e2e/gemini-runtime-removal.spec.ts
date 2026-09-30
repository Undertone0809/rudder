import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import { agents, createDb, heartbeatRuns } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL, E2E_INSTANCE_ROOT } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test("a stored Gemini CLI Agent Run fails without spawning and the Agent can be reconfigured", async ({ page }) => {
  test.setTimeout(90_000);

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Gemini-Runtime-Removed-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const createGeminiRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: { name: "Rejected Gemini Agent", role: "engineer", agentRuntimeType: "gemini_local", agentRuntimeConfig: {} },
  });
  expect(createGeminiRes.status()).toBe(400);

  const spawnSentinel = path.join(E2E_INSTANCE_ROOT, `gemini-process-spawned-${randomUUID()}`);
  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Legacy Gemini Agent",
      role: "engineer",
      agentRuntimeType: "process",
      agentRuntimeConfig: {
        command: process.execPath,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(spawnSentinel)}, "spawned")`],
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json() as { id: string; urlKey: string };

  await e2eDb.update(agents)
    .set({ agentRuntimeType: "gemini_local" })
    .where(eq(agents.id, agent.id));
  const [storedAgent] = await e2eDb.select({
    agentRuntimeType: agents.agentRuntimeType,
  }).from(agents).where(eq(agents.id, agent.id));
  expect(storedAgent?.agentRuntimeType).toBe("gemini_local");

  const historyRunId = randomUUID();
  const historyLogRef = `${organization.id}/${agent.id}/${historyRunId}.ndjson`;
  const historyLogPath = path.join(E2E_INSTANCE_ROOT, "data/run-logs", historyLogRef);
  const historyLog = `${JSON.stringify({
    ts: new Date().toISOString(),
    stream: "stdout",
    chunk: [
      { type: "user", message: "HIDDEN_GEMINI_HISTORY_INPUT" },
      { type: "thinking", text: "Historical reasoning" },
      { type: "tool_use", tool_name: "activate_skill", tool_id: "history-tool", parameters: { name: "history-skill" } },
      { type: "tool_result", tool_id: "history-tool", status: "success", output: "Historical tool output" },
      { type: "message", role: "assistant", content: "Historical final reply" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  })}\n`;
  mkdirSync(path.dirname(historyLogPath), { recursive: true });
  writeFileSync(historyLogPath, historyLog);
  await e2eDb.insert(heartbeatRuns).values({
    id: historyRunId,
    orgId: organization.id,
    agentId: agent.id,
    invocationSource: "on_demand",
    status: "succeeded",
    contextSnapshot: { agentRuntimeType: "gemini_local" },
    logStore: "local_file",
    logRef: historyLogRef,
    logBytes: Buffer.byteLength(historyLog),
  });
  const readHistory = async () => {
    const response = await page.request.get(`/api/run-intelligence/runs/${historyRunId}/transcript?order=oldest&output=full`);
    expect(response.ok()).toBe(true);
    const history = await response.json();
    expect(JSON.stringify(history)).not.toContain("HIDDEN_GEMINI_HISTORY_INPUT");
    return history;
  };
  const historyBefore = await readHistory();
  expect(historyBefore.rows.map((row: { kind: string }) => row.kind))
    .toEqual(["thinking", "tool_call", "tool_result", "assistant"]);

  await page.addInitScript((orgId: string) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  const invokeRes = await page.request.post(`/api/agents/${agent.id}/heartbeat/invoke`);
  expect(invokeRes.status()).toBe(202);
  const invokedRun = await invokeRes.json() as { id: string };
  expect(invokedRun.id).toBeTruthy();

  await expect.poll(async () => {
    const response = await page.request.get(`/api/agent-runs/${invokedRun.id}`);
    if (!response.ok()) return null;
    const run = await response.json() as { status: string };
    return run.status;
  }, { timeout: 25_000, intervals: [250, 500, 1_000] }).toBe("failed");

  const runRes = await page.request.get(`/api/agent-runs/${invokedRun.id}`);
  expect(runRes.ok()).toBe(true);
  const run = await runRes.json() as {
    error: string | null;
    processPid: number | null;
    status: string;
  };
  expect(run.status).toBe("failed");
  expect(run.error).toContain("Gemini CLI runtime has been removed");
  expect(run.processPid).toBeNull();
  expect(existsSync(spawnSentinel)).toBe(false);

  const [storedRun] = await e2eDb.select({
    processPid: heartbeatRuns.processPid,
    processStartedAt: heartbeatRuns.processStartedAt,
  }).from(heartbeatRuns).where(eq(heartbeatRuns.id, invokedRun.id));
  expect(storedRun).toMatchObject({
    processPid: null,
    processStartedAt: null,
  });

  await page.goto(`/agents/${agent.id}/runs/${invokedRun.id}`, { waitUntil: "domcontentloaded" });
  const summary = page.getByTestId("run-summary-card");
  await expect(summary).toContainText("Run failed");
  await expect(summary).toContainText("The run hit a system-level execution problem.");
  if (process.env.RUDDER_GEMINI_REMOVAL_FAILURE_SCREENSHOT) {
    await page.screenshot({ path: process.env.RUDDER_GEMINI_REMOVAL_FAILURE_SCREENSHOT, fullPage: true });
  }

  await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/configuration`, {
    waitUntil: "domcontentloaded",
  });
  const legacyRuntimeAlert = page.getByRole("alert").filter({
    hasText: "Gemini CLI runtime support has been removed.",
  });
  await expect(legacyRuntimeAlert).toBeVisible();
  await page.getByRole("button", { name: "Gemini CLI (removed)", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Codex (local) Ready", exact: true }).click();
  await expect(legacyRuntimeAlert).toHaveCount(0);

  const saveResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && response.url().includes(`/api/agents/${agent.id}`),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saveResponsePromise).ok()).toBe(true);

  const refreshedRes = await page.request.get(`/api/agents/${agent.id}?orgId=${organization.id}`);
  expect(refreshedRes.ok()).toBe(true);
  const refreshed = await refreshedRes.json() as {
    agentRuntimeType: string;
    agentRuntimeConfig: Record<string, unknown>;
  };
  expect(refreshed.agentRuntimeType).toBe("codex_local");
  expect(refreshed.agentRuntimeConfig).not.toHaveProperty("args");
  const historyAfter = await readHistory();
  expect(historyAfter.rows).toEqual(historyBefore.rows);
  const historicalAnalytics = await page.request.get(`/api/agents/${agent.id}/skills/analytics?windowDays=7`);
  expect(historicalAnalytics.ok()).toBe(true);
  expect(await historicalAnalytics.json()).toMatchObject({ totalCount: 1, totalRunsWithSkills: 1 });

  const restoreGeminiRes = await page.request.patch(`/api/agents/${agent.id}`, {
    data: { agentRuntimeType: "gemini_local", agentRuntimeConfig: refreshed.agentRuntimeConfig },
  });
  expect(restoreGeminiRes.status()).toBe(400);
  const retainedRes = await page.request.get(`/api/agents/${agent.id}?orgId=${organization.id}`);
  expect(retainedRes.ok()).toBe(true);
  expect((await retainedRes.json() as { agentRuntimeType: string }).agentRuntimeType).toBe("codex_local");
  if (process.env.RUDDER_GEMINI_REMOVAL_RECONFIGURED_SCREENSHOT) {
    await page.screenshot({ path: process.env.RUDDER_GEMINI_REMOVAL_RECONFIGURED_SCREENSHOT, fullPage: true });
  }
});
