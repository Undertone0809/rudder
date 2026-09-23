import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("Could not allocate a disposable port")));
        return;
      }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function readResponse(response: Response) {
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: response.status, body: text };
  }
}

async function runChildProcess(
  command: string,
  args: string[],
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  input?: string,
) {
  return await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

type RunningFoundation = {
  child: ReturnType<typeof spawn>;
  baseUrl: string;
};

async function startPrivateFoundation(
  binaryPath: string,
  databaseUrl: string,
  actorEnvelopeKey: string,
): Promise<RunningFoundation> {
  const child = spawn(binaryPath, [], {
    env: {
      ...process.env,
      RUDDER_NATIVE_LISTEN: "127.0.0.1:0",
      RUDDER_NATIVE_DATABASE_URL: databaseUrl,
      RUDDER_NATIVE_DATABASE_REQUIRED: "true",
      RUDDER_NATIVE_ACTOR_ENVELOPE_KEY: actorEnvelopeKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) throw new Error("private Actix probe pipes are unavailable");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const stdout = createInterface({ input: child.stdout });
  const startupLine = await new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      stdout.off("line", onLine);
      child.off("error", onError);
      child.off("close", onClose);
      stdout.close();
    };
    const onLine = (line: string) => {
      cleanup();
      resolve(line);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`private Actix probe exited before startup (${code ?? signal ?? "unknown"})${stderr ? `: ${stderr}` : ""}`));
    };
    stdout.once("line", onLine);
    child.once("error", onError);
    child.once("close", onClose);
  });
  const receipt = JSON.parse(startupLine) as { boundAddr?: unknown };
  if (typeof receipt.boundAddr !== "string") {
    await stopPrivateFoundation({ child, baseUrl: "" });
    throw new Error("private Actix probe did not emit a bound address");
  }
  const baseUrl = `http://${receipt.boundAddr}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return { child, baseUrl };
    } catch {
      // The child may need a short interval between binding and readiness.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stopPrivateFoundation({ child, baseUrl });
  throw new Error(`private Actix probe did not become ready${stderr ? `: ${stderr}` : ""}`);
}

async function stopPrivateFoundation(running: RunningFoundation): Promise<void> {
  const { child } = running;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGINT");
  });
}

function bodyError(response: { body: Record<string, unknown> | string }) {
  return typeof response.body === "string"
    ? response.body
    : String(response.body.reason ?? response.body.error ?? "");
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const requireFromDb = createRequire(path.join(repoRoot, "packages/db/package.json"));
  const postgresModule = requireFromDb("postgres") as {
    default?: (...args: any[]) => any;
  } | ((...args: any[]) => any);
  const postgres = ("default" in postgresModule ? postgresModule.default : postgresModule) as (...args: any[]) => any;
  const home = await mkdtemp(path.join(os.tmpdir(), "rudder-rust-project-goal-real-entry-"));
  const apiPort = await availablePort();
  const databasePort = await availablePort();
  const instanceId = `rust-project-goal-real-entry-${process.pid}`;
  const actorEnvelopeKey = `real-entry-project-goal-${process.pid}-${Date.now()}`;
  const foundationPath = process.env.RUDDER_SERVER_FOUNDATION_PATH
    ?? path.join(repoRoot, "native/target/debug/rudder-server-foundation");
  const migrationPreflightPath = process.env.RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH
    ?? path.join(repoRoot, "native/target/debug/migration-preflight");
  const { createRustActorEnvelope } = await import("../../server/src/services/rust-foundation-bridge.js");

  Object.assign(process.env, {
    DATABASE_URL: "",
    RUDDER_HOME: home,
    RUDDER_INSTANCE_ID: instanceId,
    RUDDER_AGENT_JWT_SECRET: `real-entry-project-goal-jwt-${process.pid}-${Date.now()}`,
    RUDDER_EMBEDDED_POSTGRES_PORT: String(databasePort),
    RUDDER_MIGRATION_AUTO_APPLY: "true",
    RUDDER_MIGRATION_PROMPT: "never",
    RUDDER_NATIVE_MODE: "required",
    RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH: migrationPreflightPath,
    RUDDER_SERVER_FOUNDATION_PATH: foundationPath,
    RUDDER_NATIVE_ACTOR_ENVELOPE_KEY: actorEnvelopeKey,
    RUDDER_DEPLOYMENT_MODE: "local_trusted",
    RUDDER_RUST_MEMBER_DIRECTORY_MODE: "off",
    RUDDER_RUST_ORGANIZATION_BRANDING_MODE: "off",
    RUDDER_RUST_PROJECT_GOAL_SET_MODE: "required",
    RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS: "",
    RUDDER_OPEN_ON_LISTEN: "false",
  });

  const { startServer } = await import("../../server/src/index.js");
  const start = () => startServer({
    runtimeOwnerKind: "server",
    openOnListen: false,
    printBanner: false,
    runtimeOverrides: {
      host: "127.0.0.1",
      port: apiPort,
      serveUi: false,
      uiDevMiddleware: false,
      heartbeatSchedulerEnabled: false,
      databaseBackupEnabled: false,
    },
  });

  let current: Awaited<ReturnType<typeof startServer>> | null = null;
  let sql: ReturnType<typeof postgres> | null = null;
  try {
    current = await start();
    const health = await readResponse(await fetch(`${current.apiUrl}/api/health`));
    assert.equal(health.status, 200);
    assert.equal((health.body as { status?: string }).status, "ok");

    const createOrganization = async (name: string, issuePrefix: string) => {
      const response = await readResponse(await fetch(`${current!.apiUrl}/api/orgs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, issuePrefix }),
      }));
      assert.equal(response.status, 201);
      const organizationId = String((response.body as { id?: string }).id);
      assert.match(organizationId, /^[0-9a-f-]{36}$/u);
      return organizationId;
    };

    const createGoal = async (organizationId: string, title: string) => {
      const response = await readResponse(await fetch(`${current!.apiUrl}/api/orgs/${organizationId}/goals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      }));
      assert.equal(response.status, 201);
      const goalId = String((response.body as { id?: string }).id);
      assert.match(goalId, /^[0-9a-f-]{36}$/u);
      return goalId;
    };

    const organizationId = await createOrganization("Rust Project-Goal real entry", "RPG");
    const otherOrganizationId = await createOrganization("Rust Project-Goal other org", "RPO");
    const goalA = await createGoal(organizationId, "First real-entry goal");
    const goalB = await createGoal(organizationId, "Second real-entry goal");
    const otherGoal = await createGoal(otherOrganizationId, "Cross-organization goal");

    const projectResponse = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Rust Project-Goal real entry" }),
    }));
    assert.equal(projectResponse.status, 201);
    const projectId = String((projectResponse.body as { id?: string }).id);
    assert.match(projectId, /^[0-9a-f-]{36}$/u);

    const createWithGoalsResponse = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Rust Project-Goal create-with-goals compatibility", goalIds: [goalA] }),
    }));
    assert.equal(createWithGoalsResponse.status, 201);
    const createWithGoalsProjectId = String((createWithGoalsResponse.body as { id?: string }).id);
    assert.match(createWithGoalsProjectId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual((createWithGoalsResponse.body as { goalIds?: string[] }).goalIds, [goalA]);

    const toolingProjectResponse = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Rust Project-Goal agent tooling entry" }),
    }));
    assert.equal(toolingProjectResponse.status, 201);
    const toolingProjectId = String((toolingProjectResponse.body as { id?: string }).id);
    assert.match(toolingProjectId, /^[0-9a-f-]{36}$/u);

    const unlistedProjectResponse = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Rust Project-Goal unlisted entry" }),
    }));
    assert.equal(unlistedProjectResponse.status, 201);
    const unlistedProjectId = String((unlistedProjectResponse.body as { id?: string }).id);
    assert.match(unlistedProjectId, /^[0-9a-f-]{36}$/u);

    // Exercise the startup fence itself. A missing allowlisted UUID must be
    // rejected before any selected project changes owner; the follow-up
    // restart with the valid allowlist proves the failed run did not commit a
    // partial handoff.
    await current.stop();
    await current.dispose();
    current = null;
    const missingAllowlistProjectId = randomUUID();
    process.env.RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS = [
      projectId,
      toolingProjectId,
      missingAllowlistProjectId,
    ].join(",");
    let invalidAllowlistStartupError = "";
    try {
      current = await start();
    } catch (error) {
      invalidAllowlistStartupError = error instanceof Error ? error.message : String(error);
      current = null;
    }
    assert.ok(invalidAllowlistStartupError, "missing allowlist target must fail startup");

    process.env.RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS = [projectId, toolingProjectId].join(",");
    current = await start();
    const allowlistHealth = await readResponse(await fetch(`${current.apiUrl}/api/health`));
    assert.equal(allowlistHealth.status, 200);

    sql = postgres(current.databaseUrl, { max: 2, onnotice: () => {} });
    const allowlistStates = await sql.unsafe(
      "SELECT project_id::text AS project_id, owner "
        + "FROM project_goal_mutation_state WHERE project_id IN ($1, $2, $3, $4) ORDER BY project_id",
      [projectId, toolingProjectId, unlistedProjectId, createWithGoalsProjectId],
    );
    assert.deepEqual(
      Array.from(allowlistStates),
      [
        { project_id: projectId, owner: "rust" },
        { project_id: toolingProjectId, owner: "rust" },
        { project_id: unlistedProjectId, owner: "node" },
        { project_id: createWithGoalsProjectId, owner: "node" },
      ].sort((left, right) => left.project_id.localeCompare(right.project_id)),
    );
    await sql.end({ timeout: 2 });
    sql = null;

    const unlistedGoalSet = await readResponse(await fetch(`${current.apiUrl}/api/projects/${unlistedProjectId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": `unlisted-${unlistedProjectId}`,
        "x-rudder-required-authority": "rust",
      },
      body: JSON.stringify({ goalIds: [goalA] }),
    }));
    assert.equal(unlistedGoalSet.status, 409);
    assert.equal(bodyError(unlistedGoalSet), "mutation_not_owned");

    // A required startup with the same allowlist must be a no-op for rows that
    // already belong to Rust. This is the recovery path after a clean restart.
    await current.stop();
    await current.dispose();
    current = null;
    process.env.RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS = [projectId, toolingProjectId].join(",");
    current = await start();
    const sameConfigRestartHealth = await readResponse(await fetch(`${current.apiUrl}/api/health`));
    assert.equal(sameConfigRestartHealth.status, 200);

    const agentResponse = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Rust Project-Goal real-entry agent",
        role: "ceo",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
      }),
    }));
    assert.equal(agentResponse.status, 201);
    const agentId = String((agentResponse.body as { id?: string }).id);
    assert.match(agentId, /^[0-9a-f-]{36}$/u);

    const keyResponse = await readResponse(await fetch(`${current.apiUrl}/api/agents/${agentId}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "project-goal-real-entry" }),
    }));
    assert.equal(keyResponse.status, 201);
    const agentApiKey = String((keyResponse.body as { token?: string }).token);
    assert.match(agentApiKey, /^pcp_[a-f0-9]{48}$/u);

    const cliRuntimeEnv = {
      RUDDER_API_URL: current.apiUrl,
      RUDDER_API_KEY: agentApiKey,
      RUDDER_ORG_ID: organizationId,
      RUDDER_AGENT_ID: agentId,
      RUDDER_TOOL_TRANSPORT_SURFACE: "cli",
    };
    const tsxPath = path.join(repoRoot, "cli/node_modules/tsx/dist/cli.mjs");
    const cliEntryPath = path.join(repoRoot, "cli/src/index.ts");
    const cliResult = await runChildProcess(
      process.execPath,
      [tsxPath, cliEntryPath, "project", "update", toolingProjectId, "--goal-ids", `${goalA},${goalB}`, "--idempotency-key", `cli-${toolingProjectId}`, "--json", "--full-ids"],
      repoRoot,
      cliRuntimeEnv,
    );
    assert.equal(cliResult.exitCode, 0, cliResult.stderr || cliResult.stdout);
    const cliBody = JSON.parse(cliResult.stdout) as { id?: string; goalIds?: string[] };
    assert.equal(cliBody.id, toolingProjectId);
    assert.deepEqual(cliBody.goalIds, [goalA, goalB]);

    const mcpResult = await runChildProcess(
      process.execPath,
      [tsxPath, cliEntryPath, "mcp-server"],
      repoRoot,
      {
        ...cliRuntimeEnv,
        RUDDER_TOOL_TRANSPORT_SURFACE: "mcp",
        // A direct Project-Goal MCP dispatch must not try this legacy process.
        RUDDER_MCP_RUDDER_BIN: path.join(home, "missing-rudder-cli"),
      },
      JSON.stringify({
        jsonrpc: "2.0",
        id: "project-goal-mcp",
        method: "tools/call",
        params: {
          name: "rudder_project_update",
          arguments: {
            project: toolingProjectId,
            goalIds: [],
            idempotencyKey: `mcp-${toolingProjectId}`,
          },
        },
      }) + "\n",
    );
    assert.equal(mcpResult.exitCode, 0, mcpResult.stderr || mcpResult.stdout);
    const mcpBody = JSON.parse(mcpResult.stdout.trim()) as {
      result?: { isError?: boolean; structuredContent?: { id?: string; goalIds?: string[] } };
    };
    assert.equal(mcpBody.result?.isError, false);
    assert.equal(typeof mcpBody.result?.structuredContent?.id, "string");
    assert.deepEqual(mcpBody.result?.structuredContent?.goalIds, []);

    sql = postgres(current.databaseUrl, { max: 2, onnotice: () => {} });
    const setGoals = async (idempotencyKey: string, goalIds: string[]) => {
      return await readResponse(await fetch(`${current!.apiUrl}/api/projects/${projectId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-rudder-idempotency-key": idempotencyKey,
          "x-rudder-required-authority": "rust",
        },
        body: JSON.stringify({ goalIds }),
      }));
    };

    // Exercise the audit failure through the public Project PATCH entrypoint.
    // The trigger is disposable test state; the assertions prove that the
    // SQLx transaction rolls back the projection, receipt, activity, and
    // outbox together before the next request retries successfully.
    const auditFailureKey = `project-goal-audit-failure-${projectId}`;
    await sql.unsafe(
      "CREATE FUNCTION fail_real_entry_project_activity() RETURNS trigger "
        + "LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'real-entry project audit failure'; END; $$",
    );
    await sql.unsafe(
      "CREATE TRIGGER fail_real_entry_project_activity_trigger "
        + "BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_real_entry_project_activity()",
    );
    const auditTriggerRows = await sql.unsafe(
      "SELECT tgname FROM pg_trigger WHERE tgname = 'fail_real_entry_project_activity_trigger'",
    );
    assert.equal(auditTriggerRows.length, 1);
    const auditFailure = await setGoals(auditFailureKey, [goalA, goalB]);
    assert.equal(auditFailure.status, 500);
    const rollbackState = await sql.unsafe(
      "SELECT mutation_version::text AS mutation_version FROM project_goal_mutation_state WHERE project_id = $1",
      [projectId],
    );
    const rollbackProject = await sql.unsafe(
      "SELECT goal_id::text AS goal_id FROM projects WHERE id = $1",
      [projectId],
    );
    const rollbackLinks = await sql.unsafe(
      "SELECT goal_id::text AS goal_id FROM project_goals WHERE project_id = $1",
      [projectId],
    );
    const failedReceipt = await sql.unsafe(
      "SELECT idempotency_key FROM organization_mutation_receipts WHERE org_id = $1 AND idempotency_key = $2",
      [organizationId, auditFailureKey],
    );
    const failedActivity = await sql.unsafe(
      "SELECT id FROM activity_log WHERE org_id = $1 AND idempotency_key = $2",
      [organizationId, auditFailureKey],
    );
    const failedOutbox = await sql.unsafe(
      "SELECT outbox.id FROM organization_mutation_outbox outbox "
        + "JOIN organization_mutation_receipts receipt ON receipt.activity_id = outbox.activity_id "
        + "WHERE receipt.org_id = $1 AND receipt.idempotency_key = $2",
      [organizationId, auditFailureKey],
    );
    assert.deepEqual(rollbackState[0], { mutation_version: "0" });
    assert.deepEqual(rollbackProject[0], { goal_id: null });
    assert.equal(rollbackLinks.length, 0);
    assert.equal(failedReceipt.length, 0);
    assert.equal(failedActivity.length, 0);
    assert.equal(failedOutbox.length, 0);
    await sql.unsafe("DROP TRIGGER fail_real_entry_project_activity_trigger ON activity_log");
    await sql.unsafe("DROP FUNCTION fail_real_entry_project_activity()");

    const mixedUpdate = await readResponse(await fetch(`${current.apiUrl}/api/projects/${projectId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": `real-project-goal-mixed-${projectId}`,
        "x-rudder-required-authority": "rust",
      },
      body: JSON.stringify({ name: "must-not-write-with-goals", goalIds: [] }),
    }));
    assert.equal(mixedUpdate.status, 409);
    assert.match(bodyError(mixedUpdate), /Project-Goal replacement/u);

    const firstKey = `real-project-goal-first-${projectId}`;
    const first = await setGoals(firstKey, [goalA, goalB]);
    assert.equal(first.status, 200);
    assert.deepEqual((first.body as { goalIds?: string[] }).goalIds, [goalA, goalB]);

    const firstState = await sql.unsafe(
      "SELECT owner, mutation_version::text AS mutation_version, fence_epoch::text AS fence_epoch "
        + "FROM project_goal_mutation_state WHERE project_id = $1",
      [projectId],
    );
    const firstProject = await sql.unsafe(
      "SELECT goal_id::text AS goal_id FROM projects WHERE id = $1",
      [projectId],
    );
    const firstLinks = await sql.unsafe(
      "SELECT goal_id::text AS goal_id FROM project_goals WHERE project_id = $1 ORDER BY goal_id",
      [projectId],
    );
    const firstReceipt = await sql.unsafe(
      "SELECT command_kind, outcome, resulting_version::text AS resulting_version, fence_epoch::text AS fence_epoch, "
        + "activity_id::text AS activity_id "
        + "FROM organization_mutation_receipts WHERE org_id = $1 AND idempotency_key = $2",
      [organizationId, firstKey],
    );
    const firstActivity = await sql.unsafe(
      "SELECT action, entity_id::text AS entity_id FROM activity_log "
        + "WHERE org_id = $1 AND action = 'project.updated' AND entity_id = $2::text",
      [organizationId, projectId],
    );
    const firstOutbox = await sql.unsafe(
      "SELECT state, attempts FROM organization_mutation_outbox "
        + "WHERE org_id = $1 AND activity_id = $2::uuid",
      [organizationId, firstReceipt[0]?.activity_id],
    );
    const expectedLinkRows = [goalA, goalB]
      .sort()
      .map((goal_id) => ({ goal_id }));
    assert.deepEqual(firstState[0], { owner: "rust", mutation_version: "1", fence_epoch: "1" });
    assert.deepEqual(firstProject[0], { goal_id: goalA });
    assert.deepEqual(Array.from(firstLinks), expectedLinkRows);
    assert.equal(firstReceipt.length, 1);
    assert.equal(firstReceipt[0]?.command_kind, "project_goal_set_replacement");
    assert.equal(firstReceipt[0]?.outcome, "applied");
    assert.equal(firstReceipt[0]?.resulting_version, "1");
    assert.equal(firstReceipt[0]?.fence_epoch, "1");
    assert.match(String(firstReceipt[0]?.activity_id), /^[0-9a-f-]{36}$/u);
    assert.equal(firstActivity.length, 1);
    assert.equal(firstOutbox.length, 1);
    assert.ok(firstOutbox[0]?.state === "pending" || firstOutbox[0]?.state === "published");

    let privateFoundation: RunningFoundation | null = null;
    let signedIdempotencySubstitutionStatus = 0;
    try {
      privateFoundation = await startPrivateFoundation(foundationPath, current.databaseUrl, actorEnvelopeKey);
      const substitutionPath = `/api/orgs/${organizationId}/projects/${projectId}/goal-set`;
      const substitutionBody = Buffer.from(JSON.stringify({
        goalIds: [goalA, goalB],
        primaryGoalId: goalA,
        runId: null,
      }), "utf8");
      const signedIdempotencyKey = `signed-project-goal-${projectId}`;
      const headerIdempotencyKey = `header-project-goal-${projectId}`;
      const requestId = randomUUID();
      const envelope = createRustActorEnvelope({
        actor: {
          type: "agent",
          agentId,
          orgId: organizationId,
          sessionId: `real-entry-direct:${agentId}`,
          authEpoch: 1,
          source: "agent_key",
        },
        organizationId,
        method: "PATCH",
        path: substitutionPath,
        action: "project.goal_set.replace",
        body: substitutionBody,
        secret: actorEnvelopeKey,
        requestId,
        idempotencyKey: signedIdempotencyKey,
      });
      const substitution = await readResponse(await fetch(`${privateFoundation.baseUrl}${substitutionPath}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-rudder-actor-envelope": JSON.stringify(envelope),
          "x-rudder-request-id": requestId,
          "x-rudder-idempotency-key": headerIdempotencyKey,
        },
        body: substitutionBody,
      }));
      assert.equal(substitution.status, 401);
      assert.equal(bodyError(substitution), "actor_envelope_invalid");
      const afterSubstitution = await sql.unsafe(
        "SELECT mutation_version::text AS mutation_version FROM project_goal_mutation_state WHERE project_id = $1",
        [projectId],
      );
      assert.deepEqual(afterSubstitution[0], { mutation_version: "1" });
      signedIdempotencySubstitutionStatus = substitution.status;
    } finally {
      if (privateFoundation) await stopPrivateFoundation(privateFoundation);
    }

    const rustOwnedOrganizationDelete = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}`, {
      method: "DELETE",
    }));
    assert.equal(rustOwnedOrganizationDelete.status, 409);
    assert.match(bodyError(rustOwnedOrganizationDelete), /Organization deletion is unavailable/u);

    const toolingState = await sql.unsafe(
      "SELECT owner, mutation_version::text AS mutation_version, fence_epoch::text AS fence_epoch "
        + "FROM project_goal_mutation_state WHERE project_id = $1",
      [toolingProjectId],
    );
    const toolingCounts = await sql.unsafe(
      "SELECT "
        + "(SELECT count(*)::text FROM organization_mutation_receipts WHERE org_id = $1 AND command_kind = 'project_goal_set_replacement' AND result->'result'->>'project_id' = $2) AS receipts, "
        + "(SELECT count(*)::text FROM activity_log WHERE org_id = $1 AND action = 'project.updated' AND entity_id = $2::text) AS activities, "
        + "(SELECT count(*)::text FROM project_goals WHERE project_id = $2::uuid) AS links",
      [organizationId, toolingProjectId],
    );
    assert.deepEqual(toolingState[0], { owner: "rust", mutation_version: "2", fence_epoch: "1" });
    assert.deepEqual(toolingCounts[0], { receipts: "2", activities: "2", links: "0" });

    const replay = await setGoals(firstKey, [goalA, goalB]);
    assert.equal(replay.status, 200);
    assert.deepEqual((replay.body as { goalIds?: string[] }).goalIds, [goalA, goalB]);
    const replayCounts = await sql.unsafe(
      "SELECT "
        + "(SELECT count(*)::text FROM organization_mutation_receipts WHERE org_id = $1 AND idempotency_key = $2) AS receipts, "
        + "(SELECT count(*)::text FROM activity_log WHERE org_id = $1 AND action = 'project.updated' AND entity_id = $3::text) AS activities, "
        + "(SELECT count(*)::text FROM organization_mutation_outbox WHERE org_id = $1 AND activity_id = $4::uuid) AS outbox",
      [organizationId, firstKey, projectId, String(firstReceipt[0]?.activity_id)],
    );
    assert.deepEqual(replayCounts[0], { receipts: "1", activities: "1", outbox: "1" });

    const idempotencyConflict = await setGoals(firstKey, []);
    assert.equal(idempotencyConflict.status, 409);
    assert.equal(bodyError(idempotencyConflict), "mutation_idempotency_conflict");

    const crossOrganization = await setGoals(`real-project-goal-cross-org-${projectId}`, [otherGoal]);
    assert.equal(crossOrganization.status, 422);
    assert.equal(bodyError(crossOrganization), "project_goal_set_invalid");
    const afterRejected = await sql.unsafe(
      "SELECT mutation_version::text AS mutation_version FROM project_goal_mutation_state WHERE project_id = $1",
      [projectId],
    );
    assert.deepEqual(afterRejected[0], { mutation_version: "1" });

    const emptyKey = `real-project-goal-empty-${projectId}`;
    const empty = await setGoals(emptyKey, []);
    assert.equal(empty.status, 200);
    assert.deepEqual((empty.body as { goalIds?: string[] }).goalIds, []);
    const afterEmpty = await sql.unsafe(
      "SELECT p.goal_id::text AS goal_id, s.mutation_version::text AS mutation_version "
        + "FROM projects p JOIN project_goal_mutation_state s ON s.project_id = p.id WHERE p.id = $1",
      [projectId],
    );
    const emptyLinks = await sql.unsafe(
      "SELECT goal_id::text AS goal_id FROM project_goals WHERE project_id = $1",
      [projectId],
    );
    assert.deepEqual(afterEmpty[0], { goal_id: null, mutation_version: "2" });
    assert.deepEqual(Array.from(emptyLinks), []);

    await sql.end({ timeout: 2 });
    sql = null;
    await current.stop();
    await current.dispose();
    current = await start();

    const replayAfterRestart = await setGoals(emptyKey, []);
    assert.equal(replayAfterRestart.status, 200);
    assert.deepEqual((replayAfterRestart.body as { goalIds?: string[] }).goalIds, []);
    sql = postgres(current.databaseUrl, { max: 2, onnotice: () => {} });
    const finalCounts = await sql.unsafe(
      "SELECT "
        + "(SELECT count(*)::text FROM organization_mutation_receipts WHERE org_id = $1 AND command_kind = 'project_goal_set_replacement') AS receipts, "
        + "(SELECT count(*)::text FROM activity_log WHERE org_id = $1 AND action = 'project.updated' AND entity_id = $2::text) AS activities, "
        + "(SELECT count(*)::text FROM project_goals WHERE project_id = $2::uuid) AS links, "
        + "(SELECT mutation_version::text FROM project_goal_mutation_state WHERE project_id = $2::uuid) AS version",
      [organizationId, projectId],
    );
    assert.deepEqual(finalCounts[0], { receipts: "4", activities: "2", links: "0", version: "2" });

    console.log(JSON.stringify({
      marker: "RUST_PROJECT_GOAL_REAL_ENTRY_PASS",
      instanceId,
      apiPort,
      databasePort,
      organizationId,
      otherOrganizationId,
      projectId,
      createWithGoalsProjectId,
      goalIds: [goalA, goalB],
      toolingProjectId,
      agentId,
      cliStatus: cliResult.exitCode,
      mcpStatus: mcpResult.exitCode,
      createWithGoalsStatus: createWithGoalsResponse.status,
      mixedUpdateStatus: mixedUpdate.status,
      auditFailureStatus: auditFailure.status,
      signedIdempotencySubstitutionStatus,
      rustOwnedOrganizationDeleteStatus: rustOwnedOrganizationDelete.status,
      allowlistStartupRejected: Boolean(invalidAllowlistStartupError),
      allowlistProjectIds: [projectId, toolingProjectId],
      sameConfigRestartHealthStatus: sameConfigRestartHealth.status,
      unlistedProjectId,
      unlistedProjectStatus: unlistedGoalSet.status,
      toolingCounts: toolingCounts[0],
      firstStatus: first.status,
      replayStatus: replay.status,
      idempotencyConflictStatus: idempotencyConflict.status,
      crossOrganizationStatus: crossOrganization.status,
      emptyStatus: empty.status,
      replayAfterRestartStatus: replayAfterRestart.status,
      finalCounts: finalCounts[0],
    }));
  } finally {
    await sql?.end({ timeout: 2 }).catch(() => undefined);
    if (current) {
      await current.stop().catch(() => undefined);
      await current.dispose().catch(() => undefined);
    }
    await rm(home, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
