import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
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
  return await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
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
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const requireFromDb = createRequire(path.join(repoRoot, "packages/db/package.json"));
  const postgresModule = requireFromDb("postgres") as {
    default?: (...args: any[]) => any;
  } | ((...args: any[]) => any);
  const postgres = ("default" in postgresModule ? postgresModule.default : postgresModule) as (...args: any[]) => any;
  const home = await mkdtemp(path.join(os.tmpdir(), "rudder-rust-branding-real-entry-"));
  const apiPort = await availablePort();
  const databasePort = await availablePort();
  const instanceId = `rust-branding-real-entry-${process.pid}`;
  const actorEnvelopeKey = `real-entry-branding-${process.pid}-${Date.now()}`;
  const foundationPath = process.env.RUDDER_SERVER_FOUNDATION_PATH
    ?? path.join(repoRoot, "native/target/debug/rudder-server-foundation");
  const migrationPreflightPath = process.env.RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH
    ?? path.join(repoRoot, "native/target/debug/migration-preflight");

  Object.assign(process.env, {
    DATABASE_URL: "",
    RUDDER_HOME: home,
    RUDDER_INSTANCE_ID: instanceId,
    RUDDER_AGENT_JWT_SECRET: `real-entry-jwt-${process.pid}-${Date.now()}`,
    RUDDER_EMBEDDED_POSTGRES_PORT: String(databasePort),
    RUDDER_MIGRATION_AUTO_APPLY: "true",
    RUDDER_MIGRATION_PROMPT: "never",
    RUDDER_NATIVE_MODE: "required",
    RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH: migrationPreflightPath,
    RUDDER_SERVER_FOUNDATION_PATH: foundationPath,
    RUDDER_NATIVE_ACTOR_ENVELOPE_KEY: actorEnvelopeKey,
    RUDDER_RUST_MEMBER_DIRECTORY_MODE: "required",
    RUDDER_RUST_ORGANIZATION_BRANDING_MODE: "required",
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

    const created = await readResponse(await fetch(`${current.apiUrl}/api/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Rust branding real entry", issuePrefix: "RBP" }),
    }));
    assert.equal(created.status, 201);
    const organizationId = String((created.body as { id?: string }).id);
    assert.match(organizationId, /^[0-9a-f-]{36}$/u);

    const idempotencyKey = `real-branding-${organizationId}`;
    const patch = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/branding`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ brandColor: "#abcdef" }),
    }));
    assert.equal(patch.status, 200);
    assert.equal((patch.body as { brandColor?: string }).brandColor, "#abcdef");

    sql = postgres(current.databaseUrl, { max: 2, onnotice: () => {} });
    const organizationRows = await sql.unsafe(
      "SELECT brand_color FROM organizations WHERE id = $1",
      [organizationId],
    );
    const stateRows = await sql.unsafe(
      "SELECT owner, mutation_version::text AS mutation_version, fence_epoch::text AS fence_epoch "
        + "FROM organization_branding_mutation_state WHERE org_id = $1",
      [organizationId],
    );
    const receiptRows = await sql.unsafe(
      "SELECT outcome, resulting_version::text AS resulting_version, fence_epoch::text AS fence_epoch "
        + "FROM organization_branding_mutation_receipts WHERE org_id = $1 AND idempotency_key = $2",
      [organizationId, idempotencyKey],
    );
    const activityRows = await sql.unsafe(
      "SELECT action FROM activity_log WHERE org_id = $1 AND action = $2",
      [organizationId, "organization.branding_updated"],
    );
    const outboxRows = await sql.unsafe(
      "SELECT state, attempts FROM organization_mutation_outbox "
        + "WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1",
      [organizationId],
    );
    assert.equal(organizationRows[0]?.brand_color, "#abcdef");
    assert.deepEqual(stateRows[0], { owner: "rust", mutation_version: "1", fence_epoch: "1" });
    assert.deepEqual(receiptRows[0], { outcome: "applied", resulting_version: "1", fence_epoch: "1" });
    assert.deepEqual(Array.from(activityRows), [{ action: "organization.branding_updated" }]);
    assert.equal(outboxRows.length, 1);
    assert.ok(outboxRows[0]?.state === "pending" || outboxRows[0]?.state === "published");

    await sql.end({ timeout: 2 });
    sql = null;
    await current.stop();
    await current.dispose();
    current = await start();
    sql = postgres(current.databaseUrl, { max: 2, onnotice: () => {} });

    const replay = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/branding`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ brandColor: "#abcdef" }),
    }));
    assert.equal(replay.status, 200);
    assert.equal((replay.body as { brandColor?: string }).brandColor, "#abcdef");

    // Force the public Rust transaction to fail at its audit insert. The
    // disposable trigger verifies that business state, the receipt, and the
    // outbox do not partially commit when activity logging fails.
    const auditFailureKey = `audit-failure-${organizationId}`;
    await sql?.unsafe(
      "CREATE FUNCTION fail_real_entry_activity() RETURNS trigger "
        + "LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'real-entry audit failure'; END; $$",
    );
    await sql?.unsafe(
      "CREATE TRIGGER fail_real_entry_activity_trigger "
        + "BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_real_entry_activity()",
    );
    const auditTriggerRows = await sql?.unsafe(
      "SELECT tgname FROM pg_trigger WHERE tgname = 'fail_real_entry_activity_trigger'",
    );
    assert.equal(auditTriggerRows?.length, 1);
    const auditFailure = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/branding`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": auditFailureKey,
      },
      body: JSON.stringify({ brandColor: "#deadbe" }),
    }));
    assert.equal(auditFailure.status, 500);
    const rollbackOrganizationRows = await sql?.unsafe(
      "SELECT brand_color FROM organizations WHERE id = $1",
      [organizationId],
    );
    const rollbackStateRows = await sql?.unsafe(
      "SELECT mutation_version::text AS mutation_version FROM organization_branding_mutation_state WHERE org_id = $1",
      [organizationId],
    );
    const failedReceiptRows = await sql?.unsafe(
      "SELECT idempotency_key FROM organization_branding_mutation_receipts WHERE org_id = $1 AND idempotency_key = $2",
      [organizationId, auditFailureKey],
    );
    const failedActivityRows = await sql?.unsafe(
      "SELECT id FROM activity_log WHERE org_id = $1 AND idempotency_key = $2",
      [organizationId, auditFailureKey],
    );
    const failedOutboxRows = await sql?.unsafe(
      "SELECT id FROM organization_mutation_outbox WHERE org_id = $1",
      [organizationId],
    );
    assert.equal(rollbackOrganizationRows?.[0]?.brand_color, "#abcdef");
    assert.deepEqual(rollbackStateRows?.[0], { mutation_version: "1" });
    assert.equal(failedReceiptRows?.length, 0);
    assert.equal(failedActivityRows?.length, 0);
    assert.equal(failedOutboxRows?.length, outboxRows.length);
    await sql?.unsafe("DROP TRIGGER fail_real_entry_activity_trigger ON activity_log");
    await sql?.unsafe("DROP FUNCTION fail_real_entry_activity()");
    const auditRetry = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/branding`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": `audit-retry-${organizationId}`,
      },
      body: JSON.stringify({ brandColor: "#fedcba" }),
    }));
    assert.equal(auditRetry.status, 200);
    assert.equal((auditRetry.body as { brandColor?: string }).brandColor, "#fedcba");

    const agentResponse = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Rust branding real-entry agent",
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
      body: JSON.stringify({ name: "branding-real-entry" }),
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
      [tsxPath, cliEntryPath, "org", "brand-color", "update", "--org-id", organizationId, "--brand-color", "#bada55", "--idempotency-key", `cli-${organizationId}`, "--json"],
      repoRoot,
      cliRuntimeEnv,
    );
    assert.equal(cliResult.exitCode, 0, cliResult.stderr || cliResult.stdout);
    const cliBody = JSON.parse(cliResult.stdout) as { brandColor?: string };
    assert.equal(cliBody.brandColor, "#bada55");

    const mcpResult = await runChildProcess(
      process.execPath,
      [tsxPath, cliEntryPath, "mcp-server"],
      repoRoot,
      {
        ...cliRuntimeEnv,
        RUDDER_TOOL_TRANSPORT_SURFACE: "mcp",
        RUDDER_MCP_RUDDER_BIN: path.join(home, "missing-rudder-cli"),
      },
      JSON.stringify({
        jsonrpc: "2.0",
        id: "branding-mcp",
        method: "tools/call",
        params: {
          name: "rudder_organization_brand_color_update",
          arguments: {
            brandColor: "#c0ffee",
            idempotencyKey: `mcp-${organizationId}`,
          },
        },
      }) + "\n",
    );
    assert.equal(mcpResult.exitCode, 0, mcpResult.stderr || mcpResult.stdout);
    const mcpBody = JSON.parse(mcpResult.stdout.trim()) as {
      result?: { isError?: boolean; structuredContent?: { brandColor?: string } };
    };
    assert.equal(mcpBody.result?.isError, false);
    assert.equal(mcpBody.result?.structuredContent?.brandColor, "#c0ffee");

    // Leave a claimed outbox row in its persisted retry window, interrupt the
    // server process cleanly, then prove the restarted publisher completes it.
    sql = postgres(current.databaseUrl, { max: 2, onnotice: () => {} });
    const recoveryCandidateRows = await sql.unsafe(
      "SELECT id::text AS id FROM organization_mutation_outbox "
        + "WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1",
      [organizationId],
    );
    const recoveryOutboxId = String(recoveryCandidateRows[0]?.id);
    assert.match(recoveryOutboxId, /^[0-9a-f-]{36}$/u);
    await sql.unsafe(
      "UPDATE organization_mutation_outbox SET state='pending', attempts=1, "
        + "next_attempt_at=now() + interval '1 hour', last_error=$2 WHERE id=$1::uuid",
      [recoveryOutboxId, "simulated process interruption before publication"],
    );
    const interruptedOutboxRows = await sql.unsafe(
      "SELECT state, attempts, last_error FROM organization_mutation_outbox WHERE id=$1::uuid",
      [recoveryOutboxId],
    );
    assert.deepEqual(interruptedOutboxRows[0], {
      state: "pending",
      attempts: 1,
      last_error: "simulated process interruption before publication",
    });
    await sql.end({ timeout: 2 });
    sql = null;
    await current.stop();
    await current.dispose();
    current = await start();
    sql = postgres(current.databaseUrl, { max: 2, onnotice: () => {} });
    await sql.unsafe(
      "UPDATE organization_mutation_outbox SET next_attempt_at=now() WHERE id=$1::uuid",
      [recoveryOutboxId],
    );
    let recoveredOutboxRows: Array<{ state: string; attempts: number; last_error: string | null }> = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      recoveredOutboxRows = await sql.unsafe(
        "SELECT state, attempts, last_error FROM organization_mutation_outbox WHERE id=$1::uuid",
        [recoveryOutboxId],
      ) as Array<{ state: string; attempts: number; last_error: string | null }>;
      if (recoveredOutboxRows[0]?.state === "published") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(recoveredOutboxRows[0]?.state, "published");
    assert.ok((recoveredOutboxRows[0]?.attempts ?? 0) >= 2);
    assert.equal(recoveredOutboxRows[0]?.last_error, null);

    console.log(JSON.stringify({
      marker: "RUST_BRANDING_REAL_ENTRY_PASS",
      instanceId,
      apiPort,
      databasePort,
      organizationId,
      firstPatchStatus: patch.status,
      replayStatus: replay.status,
      auditFailureStatus: auditFailure.status,
      auditRetryStatus: auditRetry.status,
      cliStatus: cliResult.exitCode,
      mcpStatus: mcpResult.exitCode,
      cliBrandColor: cliBody.brandColor,
      mcpBrandColor: mcpBody.result?.structuredContent?.brandColor,
      state: stateRows[0],
      receipt: receiptRows[0],
      activityCount: activityRows.length,
      outbox: outboxRows[0],
      outboxRecovery: recoveredOutboxRows[0],
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
