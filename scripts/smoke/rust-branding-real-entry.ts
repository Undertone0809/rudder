import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../../packages/db/src/index.js";
import { organizationService } from "../../server/src/services/orgs.js";

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
    RUDDER_DEPLOYMENT_MODE: "local_trusted",
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
  let legacyDb: ReturnType<typeof createDb> | null = null;
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

    const idempotencyKey = `real-branding-initial-${organizationId}`;
    const patch = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/branding`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": idempotencyKey,
        "x-rudder-required-authority": "rust",
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
    assert.ok(["pending", "claimed", "published"].includes(String(outboxRows[0]?.state)));

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
    const cliIdempotencyKey = `real-branding-cli-${organizationId}`;
    const cliResult = await runChildProcess(
      process.execPath,
      [
        tsxPath,
        cliEntryPath,
        "org",
        "brand-color",
        "update",
        "--org-id",
        organizationId,
        "--brand-color",
        "#123456",
        "--idempotency-key",
        cliIdempotencyKey,
        "--json",
        "--full-ids",
      ],
      repoRoot,
      cliRuntimeEnv,
    );
    assert.equal(cliResult.exitCode, 0, cliResult.stderr || cliResult.stdout);
    const cliBody = JSON.parse(cliResult.stdout.trim()) as { id?: string; brandColor?: string };
    assert.equal(cliBody.id, organizationId);
    assert.equal(cliBody.brandColor, "#123456");

    const cliReplay = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/branding`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${agentApiKey}`,
        "x-rudder-agent-id": agentId,
        "x-rudder-idempotency-key": cliIdempotencyKey,
        "x-rudder-required-authority": "rust",
      },
      body: JSON.stringify({ brandColor: "#123456" }),
    }));
    assert.equal(cliReplay.status, 200);
    assert.equal((cliReplay.body as { brandColor?: string }).brandColor, "#123456");

    const conflictBefore = await sql.unsafe(
      "SELECT o.brand_color, s.mutation_version::text AS mutation_version "
        + "FROM organizations o "
        + "JOIN organization_branding_mutation_state s ON s.org_id = o.id "
        + "WHERE o.id = $1",
      [organizationId],
    );
    assert.deepEqual(conflictBefore[0], { brand_color: "#123456", mutation_version: "2" });
    const idempotencyConflict = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/branding`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${agentApiKey}`,
        "x-rudder-agent-id": agentId,
        "x-rudder-idempotency-key": cliIdempotencyKey,
        "x-rudder-required-authority": "rust",
      },
      body: JSON.stringify({ brandColor: "#654321" }),
    }));
    assert.equal(idempotencyConflict.status, 409);
    assert.equal(bodyError(idempotencyConflict), "mutation_idempotency_conflict");
    const conflictAfter = await sql.unsafe(
      "SELECT o.brand_color, s.mutation_version::text AS mutation_version "
        + "FROM organizations o "
        + "JOIN organization_branding_mutation_state s ON s.org_id = o.id "
        + "WHERE o.id = $1",
      [organizationId],
    );
    assert.deepEqual(Array.from(conflictAfter), Array.from(conflictBefore));

    const mcpIdempotencyKey = `real-branding-mcp-${organizationId}`;
    const mcpResult = await runChildProcess(
      process.execPath,
      [tsxPath, cliEntryPath, "mcp-server"],
      repoRoot,
      {
        ...cliRuntimeEnv,
        RUDDER_TOOL_TRANSPORT_SURFACE: "mcp",
        // The brand-color tool is directly dispatched and must not fall back
        // to a legacy CLI process when this path is unavailable.
        RUDDER_MCP_RUDDER_BIN: path.join(home, "missing-rudder-cli"),
      },
      JSON.stringify({
        jsonrpc: "2.0",
        id: "organization-branding-mcp",
        method: "tools/call",
        params: {
          name: "rudder_organization_brand_color_update",
          arguments: {
            brandColor: "#445566",
            idempotencyKey: mcpIdempotencyKey,
          },
        },
      }) + "\n",
    );
    assert.equal(mcpResult.exitCode, 0, mcpResult.stderr || mcpResult.stdout);
    const mcpBody = JSON.parse(mcpResult.stdout.trim()) as {
      result?: { isError?: boolean; structuredContent?: { id?: string; brandColor?: string } };
    };
    assert.equal(mcpBody.result?.isError, false);
    assert.equal(typeof mcpBody.result?.structuredContent?.id, "string");
    assert.equal(mcpBody.result?.structuredContent?.brandColor, "#445566");

    const genericScalarKey = `real-branding-generic-${organizationId}`;
    const genericScalar = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": genericScalarKey,
        "x-rudder-required-authority": "rust",
      },
      body: JSON.stringify({ brandColor: "#778899" }),
    }));
    assert.equal(genericScalar.status, 200);
    assert.equal((genericScalar.body as { brandColor?: string }).brandColor, "#778899");

    const mixedBefore = await sql.unsafe(
      "SELECT name, brand_color FROM organizations WHERE id = $1",
      [organizationId],
    );
    const mixedUpdate = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": `real-branding-mixed-${organizationId}`,
        "x-rudder-required-authority": "rust",
      },
      body: JSON.stringify({ name: "must-not-write-with-branding", brandColor: "#101010" }),
    }));
    assert.equal(mixedUpdate.status, 409);
    assert.match(bodyError(mixedUpdate), /separate requests/u);
    const mixedAfter = await sql.unsafe(
      "SELECT name, brand_color FROM organizations WHERE id = $1",
      [organizationId],
    );
    assert.deepEqual(Array.from(mixedAfter), Array.from(mixedBefore));

    const clearIdempotencyKey = `real-branding-clear-${organizationId}`;
    const clear = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/branding`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": clearIdempotencyKey,
        "x-rudder-required-authority": "rust",
      },
      body: JSON.stringify({ brandColor: null }),
    }));
    assert.equal(clear.status, 200);
    assert.equal((clear.body as { brandColor?: string | null }).brandColor, null);

    legacyDb = createDb(current.databaseUrl);
    let legacyError: unknown = null;
    try {
      await organizationService(legacyDb).update(organizationId, { brandColor: "#010203" });
    } catch (error) {
      legacyError = error;
    }
    assert.ok(legacyError instanceof Error);
    assert.match(legacyError.message, /owned by Rust/u);
    await legacyDb.$client.end({ timeout: 2 });
    legacyDb = null;

    const beforeRestart = await sql.unsafe(
      "SELECT brand_color, mutation_version::text AS mutation_version "
        + "FROM organizations o "
        + "JOIN organization_branding_mutation_state s ON s.org_id = o.id "
        + "WHERE o.id = $1",
      [organizationId],
    );
    assert.deepEqual(beforeRestart[0], { brand_color: null, mutation_version: "5" });

    await sql.end({ timeout: 2 });
    sql = null;
    await current.stop();
    await current.dispose();
    current = null;
    current = await start();
    const restartHealth = await readResponse(await fetch(`${current.apiUrl}/api/health`));
    assert.equal(restartHealth.status, 200);
    assert.equal((restartHealth.body as { status?: string }).status, "ok");

    const replay = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/branding`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": clearIdempotencyKey,
        "x-rudder-required-authority": "rust",
      },
      body: JSON.stringify({ brandColor: null }),
    }));
    assert.equal(replay.status, 200);
    assert.equal((replay.body as { brandColor?: string | null }).brandColor, null);

    const finalHttp = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}`));
    assert.equal(finalHttp.status, 200);
    assert.equal((finalHttp.body as { brandColor?: string | null }).brandColor, null);

    sql = postgres(current.databaseUrl, { max: 2, onnotice: () => {} });
    const finalOrganizationRows = await sql.unsafe(
      "SELECT brand_color FROM organizations WHERE id = $1",
      [organizationId],
    );
    const finalStateRows = await sql.unsafe(
      "SELECT owner, mutation_version::text AS mutation_version, fence_epoch::text AS fence_epoch "
        + "FROM organization_branding_mutation_state WHERE org_id = $1",
      [organizationId],
    );
    const finalReceiptRows = await sql.unsafe(
      "SELECT idempotency_key, outcome, resulting_version::text AS resulting_version, fence_epoch::text AS fence_epoch "
        + "FROM organization_branding_mutation_receipts WHERE org_id = $1 ORDER BY resulting_version::bigint",
      [organizationId],
    );
    const finalActivityRows = await sql.unsafe(
      "SELECT action FROM activity_log WHERE org_id = $1 AND action = $2 ORDER BY created_at",
      [organizationId, "organization.branding_updated"],
    );
    const finalOutboxRows = await sql.unsafe(
      "SELECT state, attempts FROM organization_mutation_outbox "
        + "WHERE org_id = $1 ORDER BY created_at, id",
      [organizationId],
    );
    assert.deepEqual(finalOrganizationRows[0], { brand_color: null });
    assert.deepEqual(finalStateRows[0], { owner: "rust", mutation_version: "5", fence_epoch: "1" });
    assert.deepEqual(Array.from(finalReceiptRows), [
      { idempotency_key: idempotencyKey, outcome: "applied", resulting_version: "1", fence_epoch: "1" },
      { idempotency_key: cliIdempotencyKey, outcome: "applied", resulting_version: "2", fence_epoch: "1" },
      { idempotency_key: mcpIdempotencyKey, outcome: "applied", resulting_version: "3", fence_epoch: "1" },
      { idempotency_key: genericScalarKey, outcome: "applied", resulting_version: "4", fence_epoch: "1" },
      { idempotency_key: clearIdempotencyKey, outcome: "applied", resulting_version: "5", fence_epoch: "1" },
    ]);
    assert.equal(finalActivityRows.length, 5);
    assert.equal(finalOutboxRows.length, 5);
    for (const row of finalOutboxRows) {
      assert.ok(["pending", "claimed", "published"].includes(String(row.state)));
    }

    console.log(JSON.stringify({
      marker: "RUST_BRANDING_REAL_ENTRY_PASS",
      instanceId,
      apiPort,
      databasePort,
      organizationId,
      firstPatchStatus: patch.status,
      cliExitCode: cliResult.exitCode,
      cliBrandColor: cliBody.brandColor,
      mcpExitCode: mcpResult.exitCode,
      mcpBrandColor: mcpBody.result?.structuredContent?.brandColor,
      cliReplayStatus: cliReplay.status,
      idempotencyConflictStatus: idempotencyConflict.status,
      mixedUpdateStatus: mixedUpdate.status,
      genericScalarStatus: genericScalar.status,
      clearStatus: clear.status,
      restartHealthStatus: restartHealth.status,
      replayStatus: replay.status,
      legacyUpdateRejected: true,
      finalHttpBrandColor: (finalHttp.body as { brandColor?: string | null }).brandColor,
      finalSqlBrandColor: finalOrganizationRows[0]?.brand_color ?? null,
      state: finalStateRows[0],
      receipts: finalReceiptRows,
      activityCount: finalActivityRows.length,
      outbox: finalOutboxRows,
    }));
  } finally {
    await sql?.end({ timeout: 2 }).catch(() => undefined);
    await legacyDb?.$client.end({ timeout: 2 }).catch(() => undefined);
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
