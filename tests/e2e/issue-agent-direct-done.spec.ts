import { expect, test, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "../../packages/db/src/index.ts";
import { createLocalAgentJwt } from "../../server/src/agent-auth-jwt.ts";
import { E2E_BASE_URL, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);
const repoRoot = path.resolve(import.meta.dirname, "../..");

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

async function createFixture(page: Page, title: string) {
  const orgResponse = await page.request.post("/api/orgs", {
    data: { name: `Direct Done ${Date.now()} ${randomUUID().slice(0, 8)}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const org = await orgResponse.json();
  const agentResponse = await page.request.post(`/api/orgs/${org.id}/agents`, {
    data: {
      name: "Completion Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.6-luna" },
    },
  });
  expect(agentResponse.ok()).toBe(true);
  const agent = await agentResponse.json();
  const issueResponse = await page.request.post(`/api/orgs/${org.id}/issues`, {
    data: {
      title,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agent.id,
    },
  });
  expect(issueResponse.ok()).toBe(true);
  return { org, agent, issue: await issueResponse.json() };
}

async function runIssueDone(input: {
  orgId: string;
  agentId: string;
  runId: string;
  token: string;
  issueIdentifier: string;
  comment: string;
}) {
  const child = spawn(process.execPath, [
    path.join(repoRoot, "cli/node_modules/tsx/dist/cli.mjs"),
    path.join(repoRoot, "cli/src/index.ts"),
    "issue",
    "done",
    input.issueIdentifier,
    "--comment-file",
    "-",
    "--json",
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RUDDER_API_URL: E2E_BASE_URL,
      RUDDER_API_KEY: input.token,
      RUDDER_ORG_ID: input.orgId,
      RUDDER_AGENT_ID: input.agentId,
      RUDDER_RUN_ID: input.runId,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(input.comment);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { exitCode, stdout, stderr };
}

test("agent CLI completes without checkout while preserving an active checkout conflict", async ({ page }) => {
  await page.goto("/");
  const fixture = await createFixture(page, "Complete directly without checkout");
  const runId = randomUUID();
  await e2eDb.insert(heartbeatRuns).values({
    id: runId,
    orgId: fixture.org.id,
    agentId: fixture.agent.id,
    invocationSource: "automation",
    triggerDetail: "system",
    status: "running",
    startedAt: new Date(),
    contextSnapshot: { issueId: fixture.issue.id, taskId: fixture.issue.id },
  });
  const token = createLocalAgentJwt(fixture.agent.id, fixture.org.id, "codex_local", runId);

  const directDone = await runIssueDone({
    orgId: fixture.org.id,
    agentId: fixture.agent.id,
    runId,
    token,
    issueIdentifier: fixture.issue.identifier,
    comment: "Implementation and verification are complete.",
  });

  expect(directDone.exitCode, directDone.stderr).toBe(0);
  expect(JSON.parse(directDone.stdout)).toMatchObject({
    status: "done",
    checkoutRunId: null,
  });
  expect(await e2eDb.select().from(issueComments).where(eq(issueComments.issueId, fixture.issue.id)))
    .toEqual([expect.objectContaining({ body: "Implementation and verification are complete." })]);

  const lockedFixture = await createFixture(page, "Keep active checkout ownership");
  const activeCheckoutRunId = randomUUID();
  await e2eDb.insert(heartbeatRuns).values({
    id: activeCheckoutRunId,
    orgId: lockedFixture.org.id,
    agentId: lockedFixture.agent.id,
    invocationSource: "automation",
    triggerDetail: "system",
    status: "running",
    startedAt: new Date(),
    contextSnapshot: { issueId: lockedFixture.issue.id, taskId: lockedFixture.issue.id },
  });
  await e2eDb.update(issues).set({
    checkoutRunId: activeCheckoutRunId,
    executionRunId: activeCheckoutRunId,
  }).where(eq(issues.id, lockedFixture.issue.id));
  const competingRunId = randomUUID();
  await e2eDb.insert(heartbeatRuns).values({
    id: competingRunId,
    orgId: lockedFixture.org.id,
    agentId: lockedFixture.agent.id,
    invocationSource: "automation",
    triggerDetail: "system",
    status: "running",
    startedAt: new Date(),
    contextSnapshot: { issueId: lockedFixture.issue.id, taskId: lockedFixture.issue.id },
  });

  const conflictingDone = await runIssueDone({
    orgId: lockedFixture.org.id,
    agentId: lockedFixture.agent.id,
    runId: competingRunId,
    token: createLocalAgentJwt(
      lockedFixture.agent.id,
      lockedFixture.org.id,
      "codex_local",
      competingRunId,
    ),
    issueIdentifier: lockedFixture.issue.identifier,
    comment: "This competing run must not complete the issue.",
  });

  expect(conflictingDone.exitCode).toBe(1);
  expect(conflictingDone.stderr).toContain("Issue run ownership conflict");
  expect(await e2eDb.select().from(issues).where(eq(issues.id, lockedFixture.issue.id)))
    .toEqual([expect.objectContaining({ status: "in_progress", checkoutRunId: activeCheckoutRunId })]);
  expect(await e2eDb.select().from(issueComments).where(eq(issueComments.issueId, lockedFixture.issue.id)))
    .toHaveLength(0);
});
