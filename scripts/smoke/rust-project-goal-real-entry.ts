import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
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

    const mixedProjectResponse = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Rust Project-Goal mixed PATCH entry" }),
    }));
    assert.equal(mixedProjectResponse.status, 201);
    const mixedProjectId = String((mixedProjectResponse.body as { id?: string }).id);
    assert.match(mixedProjectId, /^[0-9a-f-]{36}$/u);

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
      mixedProjectId,
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

    process.env.RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS = [projectId, toolingProjectId, mixedProjectId].join(",");
    current = await start();
    const allowlistHealth = await readResponse(await fetch(`${current.apiUrl}/api/health`));
    assert.equal(allowlistHealth.status, 200);

    sql = postgres(current.databaseUrl, { max: 2, onnotice: () => {} });
    const allowlistStates = await sql.unsafe(
      "SELECT project_id::text AS project_id, owner "
        + "FROM project_goal_mutation_state WHERE project_id IN ($1, $2, $3, $4, $5) ORDER BY project_id",
      [projectId, toolingProjectId, unlistedProjectId, createWithGoalsProjectId, mixedProjectId],
    );
    assert.deepEqual(
      Array.from(allowlistStates),
      [
        { project_id: projectId, owner: "rust" },
        { project_id: toolingProjectId, owner: "rust" },
        { project_id: unlistedProjectId, owner: "node" },
        { project_id: createWithGoalsProjectId, owner: "node" },
        { project_id: mixedProjectId, owner: "rust" },
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
    process.env.RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS = [projectId, toolingProjectId, mixedProjectId].join(",");
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

    const nonCeoResponse = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Rust Project mixed PATCH engineer",
        role: "engineer",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
      }),
    }));
    assert.equal(nonCeoResponse.status, 201);
    const nonCeoAgentId = String((nonCeoResponse.body as { id?: string }).id);
    assert.match(nonCeoAgentId, /^[0-9a-f-]{36}$/u);
    const nonCeoKeyResponse = await readResponse(await fetch(`${current.apiUrl}/api/agents/${nonCeoAgentId}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "project-mixed-real-entry" }),
    }));
    assert.equal(nonCeoKeyResponse.status, 201);
    const nonCeoApiKey = String((nonCeoKeyResponse.body as { token?: string }).token);
    assert.match(nonCeoApiKey, /^pcp_[a-f0-9]{48}$/u);

    const cliRuntimeEnv = {
      RUDDER_API_URL: current.apiUrl,
      RUDDER_API_KEY: agentApiKey,
      RUDDER_ORG_ID: organizationId,
      RUDDER_AGENT_ID: agentId,
      RUDDER_TOOL_TRANSPORT_SURFACE: "cli",
    };
    const tsxPath = path.join(repoRoot, "cli/node_modules/tsx/dist/cli.mjs");
    const cliEntryPath = path.join(repoRoot, "cli/src/index.ts");
    const cliMixedKey = `cli-${toolingProjectId}`;
    const mcpMixedKey = `mcp-${toolingProjectId}`;
    assert.notEqual(cliMixedKey, mcpMixedKey);
    sql = postgres(current.databaseUrl, { max: 2, onnotice: () => {} });
    const assertToolingMixedPatch = async (input: {
      idempotencyKey: string;
      actorId: string;
      name: string;
      description: string;
      goalIds: string[];
      version: string;
    }) => {
      const receiptRows = await sql!.unsafe(
        "SELECT command_kind, outcome, resulting_version::text AS resulting_version, "
          + "activity_id::text AS activity_id, result->'result'->>'kind' AS result_kind, idempotency_key "
          + "FROM organization_mutation_receipts WHERE org_id = $1 AND idempotency_key = $2",
        [organizationId, input.idempotencyKey],
      );
      assert.equal(receiptRows.length, 1);
      const activityId = String(receiptRows[0]?.activity_id);
      assert.match(activityId, /^[0-9a-f-]{36}$/u);
      const [projectRows, goalLinks, activityRows, outboxRows] = await Promise.all([
        sql!.unsafe(
          "SELECT name, description, status, goal_id::text AS goal_id FROM projects WHERE id = $1 AND org_id = $2",
          [toolingProjectId, organizationId],
        ),
        sql!.unsafe(
          "SELECT goal_id::text AS goal_id FROM project_goals WHERE project_id = $1 ORDER BY goal_id",
          [toolingProjectId],
        ),
        sql!.unsafe(
          "SELECT action, actor_type, actor_id::text AS actor_id, agent_id::text AS agent_id, "
            + "details->>'name' AS name, details->>'description' AS description, details->'goalIds' AS goal_ids "
            + "FROM activity_log WHERE org_id = $1 AND id = $2::uuid",
          [organizationId, activityId],
        ),
        sql!.unsafe(
          "SELECT event_type, payload->>'action' AS action FROM organization_mutation_outbox "
            + "WHERE org_id = $1 AND activity_id = $2::uuid",
          [organizationId, activityId],
        ),
      ]);
      assert.deepEqual(receiptRows[0], {
        command_kind: "project_goal_set_replacement",
        outcome: "applied",
        resulting_version: input.version,
        activity_id: activityId,
        result_kind: "project_patch",
        idempotency_key: input.idempotencyKey,
      });
      assert.deepEqual(projectRows[0], {
        name: input.name,
        description: input.description,
        status: "in_progress",
        goal_id: input.goalIds[0] ?? null,
      });
      assert.deepEqual(Array.from(goalLinks), input.goalIds.map((goal_id) => ({ goal_id })).sort((a, b) => a.goal_id.localeCompare(b.goal_id)));
      assert.deepEqual(activityRows[0], {
        action: "project.updated",
        actor_type: "agent",
        actor_id: input.actorId,
        agent_id: input.actorId,
        name: input.name,
        description: input.description,
        goal_ids: input.goalIds,
      });
      assert.deepEqual(Array.from(outboxRows), [{ event_type: "activity.logged", action: "project.updated" }]);
      return activityId;
    };
    const cliResult = await runChildProcess(
      process.execPath,
      [
        tsxPath,
        cliEntryPath,
        "project",
        "update",
        toolingProjectId,
        "--name",
        "CLI mixed Project update",
        "--description",
        "CLI scalar and goal mutation",
        "--status",
        "in_progress",
        "--goal-ids",
        `${goalA},${goalB}`,
        "--idempotency-key",
        cliMixedKey,
        "--json",
        "--full-ids",
      ],
      repoRoot,
      cliRuntimeEnv,
    );
    assert.equal(cliResult.exitCode, 0, cliResult.stderr || cliResult.stdout);
    const cliBody = JSON.parse(cliResult.stdout) as { id?: string; name?: string; description?: string; status?: string; goalIds?: string[] };
    assert.equal(cliBody.id, toolingProjectId);
    assert.equal(cliBody.name, "CLI mixed Project update");
    assert.equal(cliBody.description, "CLI scalar and goal mutation");
    assert.equal(cliBody.status, "in_progress");
    assert.deepEqual(cliBody.goalIds, [goalA, goalB]);
    const cliMixedActivityId = await assertToolingMixedPatch({
      idempotencyKey: cliMixedKey,
      actorId: agentId,
      name: "CLI mixed Project update",
      description: "CLI scalar and goal mutation",
      goalIds: [goalA, goalB],
      version: "1",
    });

    const mcpResult = await runChildProcess(
      process.execPath,
      [tsxPath, cliEntryPath, "mcp-server"],
      repoRoot,
      {
        ...cliRuntimeEnv,
        RUDDER_API_KEY: nonCeoApiKey,
        RUDDER_AGENT_ID: nonCeoAgentId,
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
            name: "MCP mixed Project update",
            description: "MCP scalar and goal mutation",
            status: "in_progress",
            goalIds: [],
            idempotencyKey: mcpMixedKey,
          },
        },
      }) + "\n",
    );
    assert.equal(mcpResult.exitCode, 0, mcpResult.stderr || mcpResult.stdout);
    const mcpBody = JSON.parse(mcpResult.stdout.trim()) as {
      result?: { isError?: boolean; structuredContent?: { id?: string; name?: string; description?: string; status?: string; goalIds?: string[] } };
    };
    assert.equal(mcpBody.result?.isError, false);
    assert.equal(typeof mcpBody.result?.structuredContent?.id, "string");
    assert.equal(mcpBody.result?.structuredContent?.name, "MCP mixed Project update");
    assert.equal(mcpBody.result?.structuredContent?.description, "MCP scalar and goal mutation");
    assert.equal(mcpBody.result?.structuredContent?.status, "in_progress");
    assert.deepEqual(mcpBody.result?.structuredContent?.goalIds, []);
    const mcpMixedActivityId = await assertToolingMixedPatch({
      idempotencyKey: mcpMixedKey,
      actorId: nonCeoAgentId,
      name: "MCP mixed Project update",
      description: "MCP scalar and goal mutation",
      goalIds: [],
      version: "2",
    });
    assert.notEqual(cliMixedActivityId, mcpMixedActivityId);

    const cliScalarKey = `cli-scalar-project-update-${toolingProjectId}`;
    const runCliScalarUpdate = async () => await runChildProcess(
      process.execPath,
      [
        tsxPath,
        cliEntryPath,
        "project",
        "update",
        toolingProjectId,
        "--name",
        "CLI scalar Project update",
        "--idempotency-key",
        cliScalarKey,
        "--json",
        "--full-ids",
      ],
      repoRoot,
      cliRuntimeEnv,
    );
    const cliScalarResult = await runCliScalarUpdate();
    assert.equal(cliScalarResult.exitCode, 0, cliScalarResult.stderr || cliScalarResult.stdout);
    assert.equal((JSON.parse(cliScalarResult.stdout) as { name?: string }).name, "CLI scalar Project update");
    const cliScalarReplay = await runCliScalarUpdate();
    assert.equal(cliScalarReplay.exitCode, 0, cliScalarReplay.stderr || cliScalarReplay.stdout);
    assert.equal((JSON.parse(cliScalarReplay.stdout) as { name?: string }).name, "CLI scalar Project update");

    const mcpScalarKey = `mcp-scalar-project-update-${toolingProjectId}`;
    const runMcpScalarUpdate = async (requestId: string) => await runChildProcess(
      process.execPath,
      [tsxPath, cliEntryPath, "mcp-server"],
      repoRoot,
      {
        ...cliRuntimeEnv,
        RUDDER_API_KEY: nonCeoApiKey,
        RUDDER_AGENT_ID: nonCeoAgentId,
        RUDDER_TOOL_TRANSPORT_SURFACE: "mcp",
        RUDDER_MCP_RUDDER_BIN: path.join(home, "missing-rudder-cli"),
      },
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: {
          name: "rudder_project_update",
          arguments: {
            project: toolingProjectId,
            name: "MCP scalar Project update",
            idempotencyKey: mcpScalarKey,
          },
        },
      }) + "\n",
    );
    const mcpScalarResult = await runMcpScalarUpdate("project-scalar-mcp");
    assert.equal(mcpScalarResult.exitCode, 0, mcpScalarResult.stderr || mcpScalarResult.stdout);
    const parseMcpScalarResult = (stdout: string) => JSON.parse(stdout.trim()) as {
      result?: { isError?: boolean; structuredContent?: { name?: string } };
    };
    const mcpScalarBody = parseMcpScalarResult(mcpScalarResult.stdout);
    assert.equal(mcpScalarBody.result?.isError, false);
    assert.equal(mcpScalarBody.result?.structuredContent?.name, "MCP scalar Project update");
    const mcpScalarReplay = await runMcpScalarUpdate("project-scalar-mcp-replay");
    assert.equal(mcpScalarReplay.exitCode, 0, mcpScalarReplay.stderr || mcpScalarReplay.stdout);
    const mcpScalarReplayBody = parseMcpScalarResult(mcpScalarReplay.stdout);
    assert.equal(mcpScalarReplayBody.result?.isError, false);
    assert.equal(mcpScalarReplayBody.result?.structuredContent?.name, "MCP scalar Project update");

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

    const mixedKey = `real-project-goal-mixed-${mixedProjectId}`;
    const mixedPatch = {
      goalIds: [goalA, goalB],
      name: "Rust required-mode mixed patch",
      description: "One public Project and Goal transaction",
      status: "in_progress",
      leadAgentId: nonCeoAgentId,
      targetDate: "2026-10-01",
      color: "#123abc",
      icon: "folder",
      executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace" },
      resourceAttachments: [],
      newResources: [
        {
          name: "Mixed PATCH research brief",
          kind: "url",
          sourceType: "external",
          locator: `https://example.test/${mixedProjectId}/brief`,
          description: "First inline source",
          role: "reference",
          note: "Background source",
          sortOrder: 1,
          isPrimary: false,
        },
        {
          name: "Mixed PATCH test plan",
          kind: "url",
          sourceType: "external",
          locator: `https://example.test/${mixedProjectId}/test-plan`,
          description: "Primary deliverable",
          role: "deliverable",
          note: "Acceptance plan",
          sortOrder: 2,
          isPrimary: true,
        },
      ],
    };
    const sendMixedPatch = async (patch = mixedPatch, idempotencyKey = mixedKey) => await readResponse(await fetch(`${current!.apiUrl}/api/projects/${mixedProjectId}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${nonCeoApiKey}`,
        "content-type": "application/json",
        "x-rudder-idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(patch),
    }));
    const mixedUpdate = await sendMixedPatch();
    assert.equal(mixedUpdate.status, 200, bodyError(mixedUpdate));
    assert.equal((mixedUpdate.body as { name?: string }).name, mixedPatch.name);
    assert.deepEqual((mixedUpdate.body as { goalIds?: string[] }).goalIds, [goalA, goalB]);

    const mixedPublicReadback = await readResponse(await fetch(`${current.apiUrl}/api/projects/${mixedProjectId}`));
    assert.equal(mixedPublicReadback.status, 200, bodyError(mixedPublicReadback));
    const mixedPublicProject = mixedPublicReadback.body as {
      id?: string;
      name?: string;
      description?: string | null;
      status?: string;
      leadAgentId?: string | null;
      targetDate?: string | null;
      color?: string | null;
      icon?: string | null;
      executionWorkspacePolicy?: Record<string, unknown> | null;
      goalIds?: string[];
      resources?: Array<{
        role?: string;
        note?: string | null;
        sortOrder?: number;
        isPrimary?: boolean;
        resource?: { name?: string; kind?: string; locator?: string };
      }>;
    };
    assert.deepEqual({
      id: mixedPublicProject.id,
      name: mixedPublicProject.name,
      description: mixedPublicProject.description,
      status: mixedPublicProject.status,
      leadAgentId: mixedPublicProject.leadAgentId,
      targetDate: mixedPublicProject.targetDate,
      color: mixedPublicProject.color,
      icon: mixedPublicProject.icon,
      executionWorkspacePolicy: mixedPublicProject.executionWorkspacePolicy,
      goalIds: [...(mixedPublicProject.goalIds ?? [])].sort(),
    }, {
      id: mixedProjectId,
      name: mixedPatch.name,
      description: mixedPatch.description,
      status: mixedPatch.status,
      leadAgentId: nonCeoAgentId,
      targetDate: mixedPatch.targetDate,
      color: mixedPatch.color,
      icon: mixedPatch.icon,
      executionWorkspacePolicy: mixedPatch.executionWorkspacePolicy,
      goalIds: [goalA, goalB].sort(),
    });
    assert.deepEqual((mixedPublicProject.resources ?? []).map((attachment) => ({
      name: attachment.resource?.name,
      kind: attachment.resource?.kind,
      locator: attachment.resource?.locator,
      role: attachment.role,
      note: attachment.note,
      sortOrder: attachment.sortOrder,
      isPrimary: attachment.isPrimary,
    })), [
      {
        name: "Mixed PATCH research brief",
        kind: "url",
        locator: `https://example.test/${mixedProjectId}/brief`,
        role: "reference",
        note: "Background source",
        sortOrder: 1,
        isPrimary: false,
      },
      {
        name: "Mixed PATCH test plan",
        kind: "url",
        locator: `https://example.test/${mixedProjectId}/test-plan`,
        role: "deliverable",
        note: "Acceptance plan",
        sortOrder: 2,
        isPrimary: true,
      },
    ]);

    const mixedProjectReadback = await sql.unsafe(
      "SELECT name, description, status, lead_agent_id::text AS lead_agent_id, target_date::text AS target_date, "
        + "color, icon, execution_workspace_policy::text AS execution_workspace_policy, goal_id::text AS goal_id "
        + "FROM projects WHERE id = $1 AND org_id = $2",
      [mixedProjectId, organizationId],
    );
    const mixedGoalLinks = await sql.unsafe(
      "SELECT goal_id::text AS goal_id FROM project_goals WHERE project_id = $1 ORDER BY goal_id",
      [mixedProjectId],
    );
    const mixedResources = await sql.unsafe(
      "SELECT resource.name, resource.kind, resource.locator, attachment.role, attachment.note, "
        + "attachment.sort_order, attachment.is_primary "
        + "FROM project_resource_attachments attachment "
        + "JOIN organization_resources resource ON resource.id = attachment.resource_id AND resource.org_id = attachment.org_id "
        + "WHERE attachment.org_id = $1 AND attachment.project_id = $2 ORDER BY attachment.sort_order",
      [organizationId, mixedProjectId],
    );
    const mixedReceipt = await sql.unsafe(
      "SELECT command_kind, outcome, resulting_version::text AS resulting_version, activity_id::text AS activity_id, "
        + "result->'result'->>'kind' AS result_kind "
        + "FROM organization_mutation_receipts WHERE org_id = $1 AND idempotency_key = $2",
      [organizationId, mixedKey],
    );
    const mixedActivity = await sql.unsafe(
      "SELECT action, actor_type, actor_id, agent_id::text AS agent_id, details->>'name' AS name, "
        + "details->'goalIds' AS goal_ids "
        + "FROM activity_log WHERE org_id = $1 AND id = $2::uuid",
      [organizationId, mixedReceipt[0]?.activity_id],
    );
    const mixedOutbox = await sql.unsafe(
      "SELECT event_type, payload->>'action' AS action FROM organization_mutation_outbox "
        + "WHERE org_id = $1 AND activity_id = $2::uuid",
      [organizationId, mixedReceipt[0]?.activity_id],
    );
    assert.deepEqual({
      ...mixedProjectReadback[0],
      execution_workspace_policy: JSON.parse(String(mixedProjectReadback[0]?.execution_workspace_policy)),
    }, {
      name: mixedPatch.name,
      description: mixedPatch.description,
      status: mixedPatch.status,
      lead_agent_id: nonCeoAgentId,
      target_date: mixedPatch.targetDate,
      color: mixedPatch.color,
      icon: mixedPatch.icon,
      execution_workspace_policy: mixedPatch.executionWorkspacePolicy,
      goal_id: goalA,
    });
    assert.deepEqual(Array.from(mixedGoalLinks), [{ goal_id: goalA }, { goal_id: goalB }].sort((a, b) => a.goal_id.localeCompare(b.goal_id)));
    assert.deepEqual(Array.from(mixedResources), [
      {
        name: "Mixed PATCH research brief",
        kind: "url",
        locator: `https://example.test/${mixedProjectId}/brief`,
        role: "reference",
        note: "Background source",
        sort_order: 1,
        is_primary: false,
      },
      {
        name: "Mixed PATCH test plan",
        kind: "url",
        locator: `https://example.test/${mixedProjectId}/test-plan`,
        role: "deliverable",
        note: "Acceptance plan",
        sort_order: 2,
        is_primary: true,
      },
    ]);
    assert.deepEqual(mixedReceipt[0], {
      command_kind: "project_goal_set_replacement",
      outcome: "applied",
      resulting_version: "1",
      activity_id: mixedReceipt[0]?.activity_id,
      result_kind: "project_patch",
    });
    assert.match(String(mixedReceipt[0]?.activity_id), /^[0-9a-f-]{36}$/u);
    assert.deepEqual(mixedActivity[0], {
      action: "project.updated",
      actor_type: "agent",
      actor_id: nonCeoAgentId,
      agent_id: nonCeoAgentId,
      name: mixedPatch.name,
      goal_ids: [goalA, goalB],
    });
    assert.deepEqual(Array.from(mixedOutbox), [{ event_type: "activity.logged", action: "project.updated" }]);

    const mixedReplay = await sendMixedPatch();
    assert.equal(mixedReplay.status, 200, bodyError(mixedReplay));
    const mixedReplayCounts = await sql.unsafe(
      "SELECT "
        + "(SELECT count(*)::text FROM organization_mutation_receipts WHERE org_id = $1 AND idempotency_key = $2) AS receipts, "
        + "(SELECT count(*)::text FROM activity_log WHERE org_id = $1 AND id = $3::uuid) AS activities, "
        + "(SELECT count(*)::text FROM organization_mutation_outbox WHERE org_id = $1 AND activity_id = $3::uuid) AS outbox, "
        + "(SELECT count(*)::text FROM project_goals WHERE project_id = $4::uuid) AS links, "
        + "(SELECT count(*)::text FROM project_resource_attachments WHERE project_id = $4::uuid) AS attachments, "
        + "(SELECT count(*)::text FROM organization_resources WHERE org_id = $1 AND locator = ANY($5::text[])) AS resources, "
        + "(SELECT mutation_version::text FROM project_goal_mutation_state WHERE project_id = $4::uuid) AS version",
      [organizationId, mixedKey, mixedReceipt[0]?.activity_id, mixedProjectId, mixedPatch.newResources.map((resource) => resource.locator)],
    );
    assert.deepEqual(mixedReplayCounts[0], {
      receipts: "1",
      activities: "1",
      outbox: "1",
      links: "2",
      attachments: "2",
      resources: "2",
      version: "1",
    });

    const mixedAuditFailureKey = `real-project-goal-mixed-audit-failure-${mixedProjectId}`;
    const mixedRollbackLocator = `https://example.test/${mixedProjectId}/rollback-retry`;
    const mixedRollbackPatch = {
      ...mixedPatch,
      goalIds: [goalB],
      name: "Mixed PATCH retry after audit rollback",
      description: "Retry the same transaction after audit recovery",
      newResources: [{
        name: "Mixed PATCH rollback resource",
        kind: "url",
        sourceType: "external",
        locator: mixedRollbackLocator,
        description: "Must not survive a failed transaction",
        role: "reference",
        note: "Rollback probe",
        sortOrder: 3,
        isPrimary: false,
      }],
    };
    const mixedStateBeforeFailure = await sql.unsafe(
      "SELECT owner, mutation_version::text AS mutation_version, fence_epoch::text AS fence_epoch "
        + "FROM project_goal_mutation_state WHERE project_id = $1",
      [mixedProjectId],
    );
    const mixedResourcesBeforeFailure = await sql.unsafe(
      "SELECT resource.locator, attachment.role FROM project_resource_attachments attachment "
        + "JOIN organization_resources resource ON resource.id = attachment.resource_id AND resource.org_id = attachment.org_id "
        + "WHERE attachment.org_id = $1 AND attachment.project_id = $2 ORDER BY resource.locator",
      [organizationId, mixedProjectId],
    );
    const readMixedMutationCounts = async (idempotencyKey: string) => await sql!.unsafe(
      "SELECT "
        + "(SELECT count(*)::text FROM organization_mutation_receipts WHERE org_id = $1 "
        + "AND result->'result'->>'project_id' = $2::text) AS receipts, "
        + "(SELECT count(*)::text FROM activity_log WHERE org_id = $1 AND action = 'project.updated' AND entity_id = $2::text) AS activities, "
        + "(SELECT count(*)::text FROM organization_mutation_outbox outbox "
        + "JOIN activity_log activity ON activity.id = outbox.activity_id "
        + "WHERE activity.org_id = $1 AND activity.entity_id = $2::text) AS outbox, "
        + "(SELECT count(*)::text FROM organization_resources WHERE org_id = $1 AND locator = $4) AS resources, "
        + "(SELECT count(*)::text FROM organization_mutation_receipts WHERE org_id = $1 AND idempotency_key = $3) AS retry_receipts",
      [organizationId, mixedProjectId, idempotencyKey, mixedRollbackLocator],
    );
    const mixedCountsBeforeFailure = await readMixedMutationCounts(mixedAuditFailureKey);
    assert.deepEqual(mixedStateBeforeFailure[0], { owner: "rust", mutation_version: "1", fence_epoch: "1" });
    assert.deepEqual(mixedCountsBeforeFailure[0], {
      receipts: "1",
      activities: "1",
      outbox: "1",
      resources: "0",
      retry_receipts: "0",
    });
    await sql.unsafe(
      "CREATE FUNCTION fail_real_entry_mixed_project_activity() RETURNS trigger "
        + "LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'real-entry mixed Project audit failure'; END; $$",
    );
    await sql.unsafe(
      "CREATE TRIGGER fail_real_entry_mixed_project_activity_trigger "
        + "BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_real_entry_mixed_project_activity()",
    );
    const mixedAuditFailure = await sendMixedPatch(mixedRollbackPatch, mixedAuditFailureKey);
    assert.equal(mixedAuditFailure.status, 500);
    await sql.unsafe("DROP TRIGGER fail_real_entry_mixed_project_activity_trigger ON activity_log");
    await sql.unsafe("DROP FUNCTION fail_real_entry_mixed_project_activity()");

    const [mixedStateAfterFailure, mixedProjectAfterFailure, mixedLinksAfterFailure, mixedResourcesAfterFailure] = await Promise.all([
      sql.unsafe(
        "SELECT owner, mutation_version::text AS mutation_version, fence_epoch::text AS fence_epoch "
          + "FROM project_goal_mutation_state WHERE project_id = $1",
        [mixedProjectId],
      ),
      sql.unsafe(
        "SELECT name, description, goal_id::text AS goal_id FROM projects WHERE id = $1 AND org_id = $2",
        [mixedProjectId, organizationId],
      ),
      sql.unsafe(
        "SELECT goal_id::text AS goal_id FROM project_goals WHERE project_id = $1 ORDER BY goal_id",
        [mixedProjectId],
      ),
      sql.unsafe(
        "SELECT resource.locator, attachment.role FROM project_resource_attachments attachment "
          + "JOIN organization_resources resource ON resource.id = attachment.resource_id AND resource.org_id = attachment.org_id "
          + "WHERE attachment.org_id = $1 AND attachment.project_id = $2 ORDER BY resource.locator",
        [organizationId, mixedProjectId],
      ),
    ]);
    const mixedFailedWriteCounts = await readMixedMutationCounts(mixedAuditFailureKey);
    assert.deepEqual(mixedStateAfterFailure[0], mixedStateBeforeFailure[0]);
    assert.deepEqual(mixedProjectAfterFailure[0], {
      name: mixedPatch.name,
      description: mixedPatch.description,
      goal_id: goalA,
    });
    assert.deepEqual(Array.from(mixedLinksAfterFailure), Array.from(mixedGoalLinks));
    assert.deepEqual(Array.from(mixedResourcesAfterFailure), Array.from(mixedResourcesBeforeFailure));
    assert.deepEqual(mixedFailedWriteCounts[0], mixedCountsBeforeFailure[0]);

    const mixedAuditRetry = await sendMixedPatch(mixedRollbackPatch, mixedAuditFailureKey);
    assert.equal(mixedAuditRetry.status, 200, bodyError(mixedAuditRetry));
    assert.equal((mixedAuditRetry.body as { name?: string }).name, mixedRollbackPatch.name);
    assert.deepEqual((mixedAuditRetry.body as { goalIds?: string[] }).goalIds, [goalB]);
    const mixedStateAfterRetry = await sql.unsafe(
      "SELECT owner, mutation_version::text AS mutation_version, fence_epoch::text AS fence_epoch "
        + "FROM project_goal_mutation_state WHERE project_id = $1",
      [mixedProjectId],
    );
    const mixedRetryCounts = await readMixedMutationCounts(mixedAuditFailureKey);
    assert.deepEqual(mixedStateAfterRetry[0], { owner: "rust", mutation_version: "2", fence_epoch: "1" });
    assert.deepEqual(mixedRetryCounts[0], {
      receipts: "2",
      activities: "2",
      outbox: "2",
      resources: "1",
      retry_receipts: "1",
    });

    const omittedGoalKey = `real-project-goal-omitted-${mixedProjectId}`;
    const omittedGoalUpdate = await readResponse(await fetch(`${current.apiUrl}/api/projects/${mixedProjectId}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${nonCeoApiKey}`,
        "content-type": "application/json",
        "x-rudder-idempotency-key": omittedGoalKey,
      },
      body: JSON.stringify({ name: "Mixed PATCH omission preserves goals" }),
    }));
    assert.equal(omittedGoalUpdate.status, 200, bodyError(omittedGoalUpdate));
    const omittedGoalLinks = await sql.unsafe(
      "SELECT p.goal_id::text AS goal_id, count(link.goal_id)::text AS link_count "
        + "FROM projects p LEFT JOIN project_goals link ON link.project_id = p.id "
        + "WHERE p.id = $1 GROUP BY p.goal_id",
      [mixedProjectId],
    );
    assert.deepEqual(omittedGoalLinks[0], { goal_id: goalB, link_count: "1" });

    const goalIdNullClear = await readResponse(await fetch(`${current.apiUrl}/api/projects/${mixedProjectId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": `real-project-goal-null-clear-${mixedProjectId}`,
      },
      body: JSON.stringify({ goalId: null }),
    }));
    assert.equal(goalIdNullClear.status, 200, bodyError(goalIdNullClear));
    const goalIdNullReadback = await sql.unsafe(
      "SELECT p.goal_id::text AS goal_id, count(link.goal_id)::text AS link_count "
        + "FROM projects p LEFT JOIN project_goals link ON link.project_id = p.id "
        + "WHERE p.id = $1 GROUP BY p.goal_id",
      [mixedProjectId],
    );
    assert.deepEqual(goalIdNullReadback[0], { goal_id: null, link_count: "0" });

    const dedicatedResourceLocator = `https://example.test/${mixedProjectId}/dedicated-resource-route`;
    const dedicatedResourceCreate = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/resources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Dedicated Project resource route",
        kind: "url",
        sourceType: "external",
        locator: dedicatedResourceLocator,
        description: "Resource used to verify Rust-owned dedicated routes",
      }),
    }));
    assert.equal(dedicatedResourceCreate.status, 201, bodyError(dedicatedResourceCreate));
    const dedicatedResourceId = String((dedicatedResourceCreate.body as { id?: string }).id);
    assert.match(dedicatedResourceId, /^[0-9a-f-]{36}$/u);
    const dedicatedAttachmentBody = {
      resourceId: dedicatedResourceId,
      role: "reference",
      note: "Attached through the public route",
      isPrimary: false,
    };
    const dedicatedAttachKey = `dedicated-resource-attach-${mixedProjectId}`;
    const dedicatedAttach = async () => await readResponse(await fetch(`${current!.apiUrl}/api/projects/${mixedProjectId}/resources`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": dedicatedAttachKey,
      },
      body: JSON.stringify(dedicatedAttachmentBody),
    }));
    const dedicatedAttachResponse = await dedicatedAttach();
    assert.equal(dedicatedAttachResponse.status, 201, bodyError(dedicatedAttachResponse));
    const dedicatedAttachmentId = String((dedicatedAttachResponse.body as { id?: string }).id);
    assert.match(dedicatedAttachmentId, /^[0-9a-f-]{36}$/u);
    const dedicatedAttachReplay = await dedicatedAttach();
    assert.equal(dedicatedAttachReplay.status, 201, bodyError(dedicatedAttachReplay));
    assert.deepEqual(dedicatedAttachReplay.body, dedicatedAttachResponse.body);

    const dedicatedUpdateKey = `dedicated-resource-update-${mixedProjectId}`;
    const dedicatedUpdate = async () => await readResponse(await fetch(
      `${current!.apiUrl}/api/projects/${mixedProjectId}/resources/${dedicatedAttachmentId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-rudder-idempotency-key": dedicatedUpdateKey,
        },
        body: JSON.stringify({ note: "Updated through the public route" }),
      },
    ));
    const dedicatedUpdateResponse = await dedicatedUpdate();
    assert.equal(dedicatedUpdateResponse.status, 200, bodyError(dedicatedUpdateResponse));
    assert.equal((dedicatedUpdateResponse.body as { id?: string }).id, dedicatedAttachmentId);
    assert.equal((dedicatedUpdateResponse.body as { note?: string }).note, "Updated through the public route");

    const dedicatedRemoveKey = `dedicated-resource-remove-${mixedProjectId}`;
    const dedicatedRemove = async () => await readResponse(await fetch(
      `${current!.apiUrl}/api/projects/${mixedProjectId}/resources/${dedicatedAttachmentId}`,
      {
        method: "DELETE",
        headers: { "x-rudder-idempotency-key": dedicatedRemoveKey },
      },
    ));
    const dedicatedRemoveResponse = await dedicatedRemove();
    assert.equal(dedicatedRemoveResponse.status, 200, bodyError(dedicatedRemoveResponse));
    assert.equal((dedicatedRemoveResponse.body as { id?: string }).id, dedicatedAttachmentId);
    const dedicatedRemoveReplay = await dedicatedRemove();
    assert.equal(dedicatedRemoveReplay.status, 200, bodyError(dedicatedRemoveReplay));
    assert.deepEqual(dedicatedRemoveReplay.body, dedicatedRemoveResponse.body);
    const dedicatedUpdateReplay = await dedicatedUpdate();
    assert.equal(dedicatedUpdateReplay.status, 200, bodyError(dedicatedUpdateReplay));
    assert.deepEqual(dedicatedUpdateReplay.body, dedicatedUpdateResponse.body);
    const dedicatedAttachAfterRemove = await dedicatedAttach();
    assert.equal(dedicatedAttachAfterRemove.status, 201, bodyError(dedicatedAttachAfterRemove));
    assert.deepEqual(dedicatedAttachAfterRemove.body, dedicatedAttachResponse.body);

    const dedicatedMutationEvidence = await sql.unsafe(
      "SELECT receipt.idempotency_key, activity.action, activity.entity_type, activity.entity_id, "
        + "count(outbox.id)::text AS outbox_count "
        + "FROM organization_mutation_receipts receipt "
        + "JOIN activity_log activity ON activity.id = receipt.activity_id "
        + "LEFT JOIN organization_mutation_outbox outbox ON outbox.activity_id = receipt.activity_id "
        + "WHERE receipt.org_id = $1 AND receipt.idempotency_key = ANY($2::text[]) "
        + "GROUP BY receipt.idempotency_key, activity.action, activity.entity_type, activity.entity_id "
        + "ORDER BY receipt.idempotency_key",
      [organizationId, [dedicatedAttachKey, dedicatedUpdateKey, dedicatedRemoveKey]],
    );
    assert.deepEqual(Array.from(dedicatedMutationEvidence), [
      {
        idempotency_key: dedicatedAttachKey,
        action: "project.resource.attached",
        entity_type: "project_resource_attachment",
        entity_id: dedicatedAttachmentId,
        outbox_count: "1",
      },
      {
        idempotency_key: dedicatedRemoveKey,
        action: "project.resource.detached",
        entity_type: "project_resource_attachment",
        entity_id: dedicatedAttachmentId,
        outbox_count: "1",
      },
      {
        idempotency_key: dedicatedUpdateKey,
        action: "project.resource.updated",
        entity_type: "project_resource_attachment",
        entity_id: dedicatedAttachmentId,
        outbox_count: "1",
      },
    ]);
    const dedicatedAttachmentRows = await sql.unsafe(
      "SELECT count(*)::text AS attachments FROM project_resource_attachments "
        + "WHERE org_id = $1 AND project_id = $2 AND resource_id = $3",
      [organizationId, mixedProjectId, dedicatedResourceId],
    );
    assert.deepEqual(dedicatedAttachmentRows[0], { attachments: "0" });

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
    assert.deepEqual(toolingState[0], { owner: "rust", mutation_version: "4", fence_epoch: "1" });
    assert.deepEqual(toolingCounts[0], { receipts: "4", activities: "4", links: "0" });

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

    const mixedStateBeforeRestart = await sql.unsafe(
      "SELECT state.owner, state.mutation_version::text AS mutation_version, state.fence_epoch::text AS fence_epoch, "
        + "project.name, project.goal_id::text AS goal_id "
        + "FROM project_goal_mutation_state state JOIN projects project ON project.id = state.project_id "
        + "WHERE state.project_id = $1",
      [mixedProjectId],
    );
    const mixedCountsBeforeRestart = await sql.unsafe(
      "SELECT "
        + "(SELECT count(*)::text FROM organization_mutation_receipts WHERE org_id = $1 "
        + "AND result->'result'->>'project_id' = $2::text) AS receipts, "
        + "(SELECT count(*)::text FROM activity_log WHERE org_id = $1 AND action = 'project.updated' AND entity_id = $2::text) AS activities, "
        + "(SELECT count(*)::text FROM organization_mutation_outbox outbox "
        + "JOIN activity_log activity ON activity.id = outbox.activity_id "
        + "WHERE activity.org_id = $1 AND activity.entity_id = $2::text) AS outbox, "
        + "(SELECT count(*)::text FROM project_goals WHERE project_id = $2::uuid) AS links, "
        + "(SELECT count(*)::text FROM project_resource_attachments WHERE org_id = $1 AND project_id = $2::uuid) AS attachments",
      [organizationId, mixedProjectId],
    );

    await sql.end({ timeout: 2 });
    sql = null;
    await current.stop();
    await current.dispose();
    current = await start();

    const mixedReplayAfterRestart = await sendMixedPatch();
    assert.equal(mixedReplayAfterRestart.status, 200, bodyError(mixedReplayAfterRestart));
    const replayAfterRestart = await setGoals(emptyKey, []);
    assert.equal(replayAfterRestart.status, 200);
    assert.deepEqual((replayAfterRestart.body as { goalIds?: string[] }).goalIds, []);
    sql = postgres(current.databaseUrl, { max: 2, onnotice: () => {} });
    const mixedStateAfterRestart = await sql.unsafe(
      "SELECT state.owner, state.mutation_version::text AS mutation_version, state.fence_epoch::text AS fence_epoch, "
        + "project.name, project.goal_id::text AS goal_id "
        + "FROM project_goal_mutation_state state JOIN projects project ON project.id = state.project_id "
        + "WHERE state.project_id = $1",
      [mixedProjectId],
    );
    const mixedCountsAfterRestart = await sql.unsafe(
      "SELECT "
        + "(SELECT count(*)::text FROM organization_mutation_receipts WHERE org_id = $1 "
        + "AND result->'result'->>'project_id' = $2::text) AS receipts, "
        + "(SELECT count(*)::text FROM activity_log WHERE org_id = $1 AND action = 'project.updated' AND entity_id = $2::text) AS activities, "
        + "(SELECT count(*)::text FROM organization_mutation_outbox outbox "
        + "JOIN activity_log activity ON activity.id = outbox.activity_id "
        + "WHERE activity.org_id = $1 AND activity.entity_id = $2::text) AS outbox, "
        + "(SELECT count(*)::text FROM project_goals WHERE project_id = $2::uuid) AS links, "
        + "(SELECT count(*)::text FROM project_resource_attachments WHERE org_id = $1 AND project_id = $2::uuid) AS attachments",
      [organizationId, mixedProjectId],
    );
    assert.deepEqual(mixedStateAfterRestart[0], mixedStateBeforeRestart[0]);
    assert.deepEqual(mixedCountsAfterRestart[0], mixedCountsBeforeRestart[0]);
    const finalCounts = await sql.unsafe(
      "SELECT "
        + "(SELECT count(*)::text FROM organization_mutation_receipts WHERE org_id = $1 "
        + "AND command_kind = 'project_goal_set_replacement' AND result->'result'->>'project_id' = $2::text) AS receipts, "
        + "(SELECT count(*)::text FROM activity_log WHERE org_id = $1 AND action = 'project.updated' AND entity_id = $2::text) AS activities, "
        + "(SELECT count(*)::text FROM project_goals WHERE project_id = $2::uuid) AS links, "
        + "(SELECT mutation_version::text FROM project_goal_mutation_state WHERE project_id = $2::uuid) AS version",
      [organizationId, projectId],
    );
    assert.deepEqual(finalCounts[0], { receipts: "2", activities: "2", links: "0", version: "2" });

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
      mixedProjectId,
      toolingProjectId,
      agentId,
      cliStatus: cliResult.exitCode,
      mcpStatus: mcpResult.exitCode,
      cliMixedKey,
      cliMixedActivityId,
      mcpMixedKey,
      mcpMixedActivityId,
      cliScalarName: "CLI scalar Project update",
      cliScalarReplayExitCode: cliScalarReplay.exitCode,
      mcpScalarName: "MCP scalar Project update",
      mcpScalarReplayExitCode: mcpScalarReplay.exitCode,
      createWithGoalsStatus: createWithGoalsResponse.status,
      mixedUpdateStatus: mixedUpdate.status,
      mixedPublicReadbackStatus: mixedPublicReadback.status,
      mixedProjectFields: {
        name: mixedProjectReadback[0]?.name,
        status: mixedProjectReadback[0]?.status,
        leadAgentId: mixedProjectReadback[0]?.lead_agent_id,
        targetDate: mixedProjectReadback[0]?.target_date,
        goalIds: Array.from(mixedGoalLinks).map((row) => row.goal_id),
      },
      mixedResourceCount: mixedResources.length,
      mixedActivityCount: mixedActivity.length,
      mixedOutboxCount: mixedOutbox.length,
      mixedReplayStatus: mixedReplay.status,
      mixedReplayCounts: mixedReplayCounts[0],
      mixedAuditFailureStatus: mixedAuditFailure.status,
      mixedAuditRetryStatus: mixedAuditRetry.status,
      mixedRollbackReadback: mixedStateAfterFailure[0],
      mixedRetryReadback: mixedStateAfterRetry[0],
      mixedReplayAfterRestartStatus: mixedReplayAfterRestart.status,
      mixedRestartCounts: mixedCountsAfterRestart[0],
      omittedGoalUpdateStatus: omittedGoalUpdate.status,
      omittedGoalLinkCount: omittedGoalLinks[0]?.link_count,
      goalIdNullClearStatus: goalIdNullClear.status,
      goalIdNullClearReadback: goalIdNullReadback[0],
      auditFailureStatus: auditFailure.status,
      signedIdempotencySubstitutionStatus,
      rustOwnedOrganizationDeleteStatus: rustOwnedOrganizationDelete.status,
      allowlistStartupRejected: Boolean(invalidAllowlistStartupError),
      allowlistProjectIds: [projectId, toolingProjectId, mixedProjectId],
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
