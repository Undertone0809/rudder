import assert from "node:assert/strict";
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

    console.log(JSON.stringify({
      marker: "RUST_BRANDING_REAL_ENTRY_PASS",
      instanceId,
      apiPort,
      databasePort,
      organizationId,
      firstPatchStatus: patch.status,
      replayStatus: replay.status,
      state: stateRows[0],
      receipt: receiptRows[0],
      activityCount: activityRows.length,
      outbox: outboxRows[0],
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
