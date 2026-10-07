import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
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
    RUDDER_RUST_ORGANIZATION_BRANDING_ORG_IDS: "",
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
    process.env.RUDDER_RUST_ORGANIZATION_BRANDING_ORG_IDS = organizationId;

    const unlistedCreated = await readResponse(await fetch(`${current.apiUrl}/api/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Rust branding unlisted real entry", issuePrefix: "RBU" }),
    }));
    assert.equal(unlistedCreated.status, 201);
    const unlistedOrganizationId = String((unlistedCreated.body as { id?: string }).id);
    assert.match(unlistedOrganizationId, /^[0-9a-f-]{36}$/u);

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
    const legacyGenericReplayBefore = await sql.unsafe(
      "SELECT o.brand_color, s.mutation_version::text AS mutation_version, "
        + "(SELECT count(*)::text FROM organization_branding_mutation_receipts WHERE org_id=$1) AS receipts, "
        + "(SELECT count(*)::text FROM activity_log WHERE org_id=$1) AS activities, "
        + "(SELECT count(*)::text FROM organization_mutation_outbox WHERE org_id=$1) AS outbox "
        + "FROM organizations o JOIN organization_branding_mutation_state s ON s.org_id=o.id "
        + "WHERE o.id=$1::uuid",
      [organizationId],
    );

    // Before the generic organization PATCH selected its own activity action,
    // Rust-owned branding requests from that route were adapted through the
    // dedicated /branding path and persisted the v1 receipt fingerprint. A
    // retry through the generic public route must continue to replay that
    // already-committed receipt rather than conflict or write a second event.
    const legacyGenericReplay = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ brandColor: "#abcdef" }),
    }));
    assert.equal(legacyGenericReplay.status, 200);
    assert.equal((legacyGenericReplay.body as { brandColor?: string }).brandColor, "#abcdef");
    const legacyGenericReplayAfter = await sql.unsafe(
      "SELECT o.brand_color, s.mutation_version::text AS mutation_version, "
        + "(SELECT count(*)::text FROM organization_branding_mutation_receipts WHERE org_id=$1) AS receipts, "
        + "(SELECT count(*)::text FROM activity_log WHERE org_id=$1) AS activities, "
        + "(SELECT count(*)::text FROM organization_mutation_outbox WHERE org_id=$1) AS outbox "
        + "FROM organizations o JOIN organization_branding_mutation_state s ON s.org_id=o.id "
        + "WHERE o.id=$1::uuid",
      [organizationId],
    );
    assert.deepEqual(Array.from(legacyGenericReplayAfter), Array.from(legacyGenericReplayBefore),
      "legacy generic retry must replay without changing business state or side-effect counts");

    const renamed = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Rust branding real entry renamed" }),
    }));
    assert.equal(renamed.status, 200);
    assert.equal((renamed.body as { name?: string }).name, "Rust branding real entry renamed");
    const descriptionUpdated = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/branding`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "Node-owned organization profile field" }),
    }));
    assert.equal(descriptionUpdated.status, 200);
    assert.equal((descriptionUpdated.body as { description?: string }).description, "Node-owned organization profile field");

    const unlistedPatch = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${unlistedOrganizationId}/branding`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brandColor: "#123456" }),
    }));
    assert.equal(unlistedPatch.status, 200);
    assert.equal((unlistedPatch.body as { brandColor?: string }).brandColor, "#123456");

    const organizationRows = await sql.unsafe(
      "SELECT name, description, brand_color FROM organizations WHERE id = $1",
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
      "SELECT action, details FROM activity_log "
        + "WHERE org_id = $1 AND entity_type = 'organization' AND entity_id = $1::text "
        + "AND action IN ('organization.updated', 'organization.branding_updated') "
        + "ORDER BY action, details::text",
      [organizationId],
    );
    const outboxRows = await sql.unsafe(
      "SELECT state, attempts FROM organization_mutation_outbox "
        + "WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1",
      [organizationId],
    );
    assert.deepEqual(organizationRows[0], {
      name: "Rust branding real entry renamed",
      description: "Node-owned organization profile field",
      brand_color: "#abcdef",
    });
    assert.deepEqual(stateRows[0], { owner: "rust", mutation_version: "1", fence_epoch: "1" });
    const unlistedStateRows = await sql.unsafe(
      "SELECT owner FROM organization_branding_mutation_state WHERE org_id = $1",
      [unlistedOrganizationId],
    );
    assert.deepEqual(Array.from(unlistedStateRows), [{ owner: "node" }]);
    assert.deepEqual(receiptRows[0], { outcome: "applied", resulting_version: "1", fence_epoch: "1" });
    assert.deepEqual(Array.from(activityRows), [
      { action: "organization.branding_updated", details: { brandColor: "#abcdef" } },
      { action: "organization.branding_updated", details: { description: "Node-owned organization profile field" } },
      { action: "organization.updated", details: { name: "Rust branding real entry renamed" } },
    ]);
    assert.equal(outboxRows.length, 1);
    assert.ok(outboxRows[0]?.state === "pending" || outboxRows[0]?.state === "published");

    await sql.end({ timeout: 2 });
    sql = null;
    await current.stop();
    await current.dispose();
    current = await start();
    sql = postgres(current.databaseUrl, { max: 2, onnotice: () => {} });
    const unlistedRestartStateRows = await sql.unsafe(
      "SELECT owner FROM organization_branding_mutation_state WHERE org_id = $1",
      [unlistedOrganizationId],
    );
    assert.deepEqual(Array.from(unlistedRestartStateRows), [{ owner: "node" }]);

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
    const auditFailureActivityKey = `rust-d1:${createHash("sha256").update(auditFailureKey).digest("hex")}`;
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
      [organizationId, auditFailureActivityKey],
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
        "x-rudder-idempotency-key": auditFailureKey,
      },
      body: JSON.stringify({ brandColor: "#deadbe" }),
    }));
    assert.equal(auditRetry.status, 200);
    assert.equal((auditRetry.body as { brandColor?: string }).brandColor, "#deadbe");
    const auditRetryEffectRows = await sql?.unsafe(
      "SELECT receipt.idempotency_key, receipt.activity_id::text AS activity_id, "
        + "activity.action, activity.idempotency_key AS activity_idempotency_key, "
        + "outbox.id::text AS outbox_id, outbox.event_type, outbox.payload "
        + "FROM organization_branding_mutation_receipts receipt "
        + "JOIN activity_log activity ON activity.org_id=receipt.org_id AND activity.id=receipt.activity_id "
        + "JOIN organization_mutation_outbox outbox ON outbox.org_id=receipt.org_id AND outbox.activity_id=receipt.activity_id "
        + "WHERE receipt.org_id=$1::uuid AND receipt.idempotency_key=$2",
      [organizationId, auditFailureKey],
    );
    assert.equal(auditRetryEffectRows?.length, 1,
      "retrying the failed request with the original key did not create one receipt-linked effect set");
    const auditRetryReplay = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/branding`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": auditFailureKey,
      },
      body: JSON.stringify({ brandColor: "#deadbe" }),
    }));
    assert.equal(auditRetryReplay.status, 200);
    assert.deepEqual(auditRetryReplay.body, auditRetry.body,
      "replaying the successfully retried request changed its response");
    const auditRetryReplayEffectRows = await sql?.unsafe(
      "SELECT receipt.idempotency_key, receipt.activity_id::text AS activity_id, "
        + "activity.action, activity.idempotency_key AS activity_idempotency_key, "
        + "outbox.id::text AS outbox_id, outbox.event_type, outbox.payload "
        + "FROM organization_branding_mutation_receipts receipt "
        + "JOIN activity_log activity ON activity.org_id=receipt.org_id AND activity.id=receipt.activity_id "
        + "JOIN organization_mutation_outbox outbox ON outbox.org_id=receipt.org_id AND outbox.activity_id=receipt.activity_id "
        + "WHERE receipt.org_id=$1::uuid AND receipt.idempotency_key=$2",
      [organizationId, auditFailureKey],
    );
    assert.deepEqual(Array.from(auditRetryReplayEffectRows ?? []), Array.from(auditRetryEffectRows ?? []),
      "same-key replay changed the receipt-linked activity or outbox rows");

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
    const childFailureMessage = (result: { stderr: string; stdout: string }) =>
      (result.stderr || result.stdout).replaceAll(agentApiKey, "[redacted]");
    const logoAssetId = randomUUID();
    const shortLogoAssetId = logoAssetId.replace(/-/gu, "").slice(0, 12);
    const foreignLogoAssetId = randomUUID();
    await sql?.unsafe(
      "INSERT INTO assets (id, org_id, provider, object_key, content_type, byte_size, sha256) "
        + "VALUES ($1::uuid, $2::uuid, 'test', $3, 'image/png', 1, $4)",
      [logoAssetId, organizationId, `branding/${logoAssetId}`, "e".repeat(64)],
    );
    await sql?.unsafe(
      "INSERT INTO assets (id, org_id, provider, object_key, content_type, byte_size, sha256) "
        + "VALUES ($1::uuid, $2::uuid, 'test', $3, 'image/png', 1, $4)",
      [foreignLogoAssetId, unlistedOrganizationId, `branding/${foreignLogoAssetId}`, "f".repeat(64)],
    );
    await sql?.unsafe(
      "INSERT INTO organization_logos (org_id, asset_id) VALUES ($1::uuid, $2::uuid)",
      [organizationId, logoAssetId],
    );
    const missingLogoAssetId = "40000000-0000-4000-8000-000000000099";
    const invalidBrandingBefore = await sql?.unsafe(
      "SELECT o.brand_color, s.mutation_version::text AS mutation_version, l.asset_id::text AS logo_asset_id, "
        + "(SELECT count(*)::text FROM organization_branding_mutation_receipts WHERE org_id=$1) AS receipts, "
        + "(SELECT count(*)::text FROM activity_log WHERE org_id=$1) AS activities, "
        + "(SELECT count(*)::text FROM organization_mutation_outbox WHERE org_id=$1) AS outbox "
        + "FROM organizations o JOIN organization_branding_mutation_state s ON s.org_id=o.id "
        + "JOIN organization_logos l ON l.org_id=o.id "
        + "WHERE o.id=$1::uuid",
      [organizationId],
    );
    const invalidBrandingAssetsBefore = await sql?.unsafe(
      "SELECT id::text AS id, org_id::text AS org_id, provider, object_key, content_type, byte_size, sha256 "
        + "FROM assets WHERE id IN ($1::uuid, $2::uuid, $3::uuid) ORDER BY id",
      [logoAssetId, foreignLogoAssetId, missingLogoAssetId],
    );
    assert.equal(invalidBrandingBefore?.[0]?.logo_asset_id, logoAssetId);
    assert.equal(invalidBrandingAssetsBefore?.length, 2, "the missing asset fixture must not exist");
    const missingLogo = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/branding`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": `missing-logo-${organizationId}`,
      },
      body: JSON.stringify({ brandColor: "#654321", logoAssetId: missingLogoAssetId }),
    }));
    assert.equal(missingLogo.status, 404);
    const foreignLogo = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/branding`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": `foreign-logo-${organizationId}`,
      },
      body: JSON.stringify({ brandColor: "#654321", logoAssetId: foreignLogoAssetId }),
    }));
    assert.equal(foreignLogo.status, 422);
    const invalidBrandingAfter = await sql?.unsafe(
      "SELECT o.brand_color, s.mutation_version::text AS mutation_version, l.asset_id::text AS logo_asset_id, "
        + "(SELECT count(*)::text FROM organization_branding_mutation_receipts WHERE org_id=$1) AS receipts, "
        + "(SELECT count(*)::text FROM activity_log WHERE org_id=$1) AS activities, "
        + "(SELECT count(*)::text FROM organization_mutation_outbox WHERE org_id=$1) AS outbox "
        + "FROM organizations o JOIN organization_branding_mutation_state s ON s.org_id=o.id "
        + "JOIN organization_logos l ON l.org_id=o.id "
        + "WHERE o.id=$1::uuid",
      [organizationId],
    );
    const invalidBrandingAssetsAfter = await sql?.unsafe(
      "SELECT id::text AS id, org_id::text AS org_id, provider, object_key, content_type, byte_size, sha256 "
        + "FROM assets WHERE id IN ($1::uuid, $2::uuid, $3::uuid) ORDER BY id",
      [logoAssetId, foreignLogoAssetId, missingLogoAssetId],
    );
    assert.deepEqual(invalidBrandingAfter, invalidBrandingBefore,
      "missing or foreign logo rejection changed branding state or side effects");
    assert.deepEqual(invalidBrandingAssetsAfter, invalidBrandingAssetsBefore,
      "missing or foreign logo rejection changed the linked or foreign asset rows");

    const cliRuntimeEnv = {
      RUDDER_API_URL: current.apiUrl,
      RUDDER_API_KEY: agentApiKey,
      RUDDER_ORG_ID: organizationId,
      RUDDER_AGENT_ID: agentId,
      RUDDER_TOOL_TRANSPORT_SURFACE: "cli",
    };
    const cliEntryPath = path.join(repoRoot, "cli/dist/index.js");
    const crossTransportBrandingInput = {
      brandColor: "#bada55",
      idempotencyKey: `cli-mcp-branding-${organizationId}`,
    };
    const runMcpBranding = async (requestId: string, input: Record<string, unknown>) => {
      const initializeRequestId = "initialize";
      const toolsListRequestId = "tools-list";
      const result = await runChildProcess(
        process.execPath,
        [cliEntryPath, "mcp-server"],
        repoRoot,
        {
          ...cliRuntimeEnv,
          RUDDER_TOOL_TRANSPORT_SURFACE: "mcp",
          RUDDER_MCP_RUDDER_BIN: path.join(home, "missing-rudder-cli"),
        },
        [
          {
            jsonrpc: "2.0",
            id: initializeRequestId,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "rust-branding-real-entry", version: "1" },
            },
          },
          { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
          { jsonrpc: "2.0", id: toolsListRequestId, method: "tools/list", params: {} },
          {
            jsonrpc: "2.0",
            id: requestId,
            method: "tools/call",
            params: {
              name: "rudder_organization_brand_color_update",
              arguments: input,
            },
          },
        ].map((message) => JSON.stringify(message)).join("\n") + "\n",
      );
      assert.equal(result.exitCode, 0, childFailureMessage(result));
      const replies = result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as {
        jsonrpc?: string;
        id?: string | number | null;
        result?: {
          protocolVersion?: string;
          tools?: Array<{ name?: string }>;
          isError?: boolean;
          structuredContent?: { brandColor?: string | null; logoAssetId?: string | null };
        };
        error?: unknown;
      });
      assert.deepEqual(replies.map((reply) => reply.id), [initializeRequestId, toolsListRequestId, requestId],
        "stdio MCP lifecycle returned unexpected JSON-RPC replies");

      const initializeReply = replies.find((reply) => reply.id === initializeRequestId);
      assert.equal(initializeReply?.jsonrpc, "2.0");
      assert.equal(initializeReply?.result?.protocolVersion, "2025-06-18");
      assert.equal(initializeReply?.error, undefined, "stdio MCP initialize returned a JSON-RPC error");

      const toolsListReply = replies.find((reply) => reply.id === toolsListRequestId);
      assert.equal(toolsListReply?.jsonrpc, "2.0");
      assert.equal(toolsListReply?.error, undefined, "stdio MCP tools/list returned a JSON-RPC error");
      assert.ok(toolsListReply?.result?.tools?.some(
        (tool) => tool.name === "rudder_organization_brand_color_update",
      ), "organization brand-color update tool was not advertised over stdio MCP");

      const callReply = replies.find((reply) => reply.id === requestId);
      assert.equal(callReply?.jsonrpc, "2.0");
      assert.equal(callReply?.error, undefined, "stdio MCP tools/call returned a JSON-RPC error");
      assert.equal(callReply?.result?.isError, false);
      const organization = callReply?.result?.structuredContent;
      assert.ok(organization, "stdio MCP tools/call omitted structuredContent");
      return { result, body: callReply, organization };
    };

    const cliResult = await runChildProcess(
      process.execPath,
      [cliEntryPath, "org", "brand-color", "update", "--org-id", organizationId,
        "--brand-color", crossTransportBrandingInput.brandColor,
        "--idempotency-key", crossTransportBrandingInput.idempotencyKey, "--json"],
      repoRoot,
      cliRuntimeEnv,
    );
    assert.equal(cliResult.exitCode, 0, childFailureMessage(cliResult));
    const cliBody = JSON.parse(cliResult.stdout) as { brandColor?: string };
    assert.equal(cliBody.brandColor, crossTransportBrandingInput.brandColor);

    const readCrossTransportBrandingSnapshot = async () => {
      const rows = await sql!.unsafe(
        "SELECT o.brand_color, s.owner, s.mutation_version::text AS mutation_version, "
          + "s.fence_epoch::text AS fence_epoch, "
          + "(SELECT count(*)::text FROM organization_branding_mutation_receipts "
          + "WHERE org_id=$1::uuid AND idempotency_key=$2) AS receipt_count, "
          + "(SELECT count(*)::text FROM organization_branding_mutation_receipts receipt "
          + "JOIN activity_log activity ON activity.org_id=receipt.org_id AND activity.id=receipt.activity_id "
          + "WHERE receipt.org_id=$1::uuid AND receipt.idempotency_key=$2) AS activity_count, "
          + "(SELECT count(*)::text FROM organization_mutation_outbox outbox "
          + "JOIN organization_branding_mutation_receipts receipt "
          + "ON receipt.org_id=outbox.org_id AND receipt.activity_id=outbox.activity_id "
          + "WHERE receipt.org_id=$1::uuid AND receipt.idempotency_key=$2) AS outbox_count "
          + "FROM organizations o JOIN organization_branding_mutation_state s ON s.org_id=o.id "
          + "WHERE o.id=$1::uuid",
        [organizationId, crossTransportBrandingInput.idempotencyKey],
      );
      assert.equal(rows.length, 1, "shared CLI/MCP branding command did not persist organization mutation state");
      return Array.from(rows)[0] as {
        brand_color: string;
        owner: string;
        mutation_version: string;
        fence_epoch: string;
        receipt_count: string;
        activity_count: string;
        outbox_count: string;
      };
    };

    const cliBrandingSnapshot = await readCrossTransportBrandingSnapshot();
    assert.equal(cliBrandingSnapshot.brand_color, crossTransportBrandingInput.brandColor);
    assert.equal(cliBrandingSnapshot.owner, "rust", "built CLI branding write was not Rust-owned");
    assert.ok(Number(cliBrandingSnapshot.mutation_version) > 0);
    assert.ok(Number(cliBrandingSnapshot.fence_epoch) > 0);
    assert.equal(cliBrandingSnapshot.receipt_count, "1");
    assert.equal(cliBrandingSnapshot.activity_count, "1");
    assert.equal(cliBrandingSnapshot.outbox_count, "1");

    const mcpReplay = await runMcpBranding("branding-mcp-replay-cli-write", crossTransportBrandingInput);
    assert.equal(mcpReplay.organization?.brandColor, crossTransportBrandingInput.brandColor);
    const mcpReplayBrandingSnapshot = await readCrossTransportBrandingSnapshot();
    assert.deepEqual(mcpReplayBrandingSnapshot, cliBrandingSnapshot,
      "same-payload MCP replay changed Rust state, receipt, activity, or outbox counts");

    const cliLogoLink = await runChildProcess(
      process.execPath,
      [cliEntryPath, "org", "brand-color", "update", "--org-id", organizationId,
        "--logo-asset-id", logoAssetId, "--idempotency-key", `cli-logo-${organizationId}`, "--json"],
      repoRoot,
      cliRuntimeEnv,
    );
    assert.equal(cliLogoLink.exitCode, 0, childFailureMessage(cliLogoLink));
    const cliLogoBody = JSON.parse(cliLogoLink.stdout) as { brandColor?: string; logoAssetId?: string };
    assert.equal(cliLogoBody.brandColor, "#bada55", "logo-only CLI update changed the omitted brand color");
    assert.equal(cliLogoBody.logoAssetId, shortLogoAssetId,
      "CLI output did not preserve Rudder's stable short-ID display convention");
    const cliLogoRows = await sql?.unsafe(
      "SELECT asset_id::text AS asset_id FROM organization_logos WHERE org_id = $1::uuid",
      [organizationId],
    );
    assert.deepEqual(Array.from(cliLogoRows ?? []), [{ asset_id: logoAssetId }]);

    const mcpLogoLink = await runMcpBranding("branding-mcp-logo-link", {
      logoAssetId: logoAssetId.toUpperCase(),
      idempotencyKey: `mcp-logo-${organizationId}`,
    });
    assert.equal(mcpLogoLink.organization?.brandColor, "#bada55");
    assert.equal(mcpLogoLink.organization?.logoAssetId, shortLogoAssetId,
      "MCP logo link did not preserve omitted brand color or Rudder's short-ID output convention");
    const mcpLogoRows = await sql?.unsafe(
      "SELECT asset_id::text AS asset_id FROM organization_logos WHERE org_id = $1::uuid",
      [organizationId],
    );
    assert.deepEqual(Array.from(mcpLogoRows ?? []), [{ asset_id: logoAssetId }],
      "MCP uppercase UUID input was not normalized to the canonical stored logo asset ID");

    const mcpLogoClear = await runMcpBranding("branding-mcp-logo-clear", {
      logoAssetId: null,
      idempotencyKey: `mcp-logo-clear-${organizationId}`,
    });
    assert.equal(mcpLogoClear.organization?.brandColor, "#bada55",
      "nullable MCP logo clear changed the omitted brand color");
    assert.equal(mcpLogoClear.organization?.logoAssetId, null);
    const clearedLogoRows = await sql?.unsafe(
      "SELECT asset_id::text AS asset_id FROM organization_logos WHERE org_id = $1::uuid",
      [organizationId],
    );
    assert.deepEqual(Array.from(clearedLogoRows ?? []), [], "MCP logo clear left the organization logo link");

    const mcpBrandColorClear = await runMcpBranding("branding-mcp-color-clear", {
      brandColor: null,
      idempotencyKey: `mcp-color-clear-${organizationId}`,
    });
    assert.equal(mcpBrandColorClear.organization?.brandColor, null);
    assert.equal(mcpBrandColorClear.organization?.logoAssetId, null,
      "nullable MCP color clear changed the omitted logo field");

    // Delay a real Rust transaction's receipt-linked outbox row in the
    // disposable database so a persisted pending event survives restart.
    // The existing publisher provides retryable at-least-once delivery; this
    // smoke verifies stable event identity, not exactly-once network delivery.
    sql = postgres(current.databaseUrl, { max: 2, onnotice: () => {} });
    const recoveryIdempotencyKey = `outbox-recovery-${organizationId}`;
    const recoveryColor = "#d00ded";
    await sql.unsafe(
      "CREATE FUNCTION delay_real_entry_outbox() RETURNS trigger "
        + "LANGUAGE plpgsql AS $$ BEGIN "
        + "NEW.next_attempt_at := now() + interval '1 hour'; "
        + "NEW.attempts := 1; "
        + "NEW.last_error := 'simulated interruption before publication'; "
        + "RETURN NEW; END; $$",
    );
    await sql.unsafe(
      "CREATE TRIGGER delay_real_entry_outbox_trigger "
        + "BEFORE INSERT ON organization_mutation_outbox "
        + "FOR EACH ROW EXECUTE FUNCTION delay_real_entry_outbox()",
    );
    const recoveryMutation = await readResponse(await fetch(`${current.apiUrl}/api/orgs/${organizationId}/branding`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-rudder-idempotency-key": recoveryIdempotencyKey,
      },
      body: JSON.stringify({ brandColor: recoveryColor }),
    }));
    assert.equal(recoveryMutation.status, 200);
    assert.equal((recoveryMutation.body as { brandColor?: string }).brandColor, recoveryColor);
    await sql.unsafe("DROP TRIGGER delay_real_entry_outbox_trigger ON organization_mutation_outbox");
    await sql.unsafe("DROP FUNCTION delay_real_entry_outbox()");

    const readRecoverySnapshot = async () => {
      const rows = await sql!.unsafe(
        "SELECT receipt.idempotency_key, receipt.activity_id::text AS activity_id, receipt.outcome, "
          + "activity.action, activity.idempotency_key AS activity_idempotency_key, "
          + "outbox.id::text AS outbox_id, outbox.event_type, outbox.payload, outbox.state, "
          + "outbox.attempts, outbox.last_error "
          + "FROM organization_branding_mutation_receipts receipt "
          + "JOIN activity_log activity ON activity.org_id=receipt.org_id AND activity.id=receipt.activity_id "
          + "JOIN organization_mutation_outbox outbox ON outbox.org_id=receipt.org_id AND outbox.activity_id=receipt.activity_id "
          + "WHERE receipt.org_id=$1::uuid AND receipt.idempotency_key=$2",
        [organizationId, recoveryIdempotencyKey],
      );
      assert.equal(rows.length, 1, "real Rust write did not produce exactly one linked recovery effect set");
      return Array.from(rows)[0] as {
        idempotency_key: string;
        activity_id: string;
        outcome: string;
        action: string;
        activity_idempotency_key: string;
        outbox_id: string;
        event_type: string;
        payload: Record<string, unknown>;
        state: string;
        attempts: number;
        last_error: string | null;
      };
    };
    const interruptedRecovery = await readRecoverySnapshot();
    assert.equal(interruptedRecovery.idempotency_key, recoveryIdempotencyKey);
    assert.equal(interruptedRecovery.outcome, "applied");
    assert.equal(interruptedRecovery.action, "organization.branding_updated");
    assert.equal(interruptedRecovery.event_type, "activity.logged");
    assert.equal(interruptedRecovery.state, "pending");
    assert.equal(interruptedRecovery.attempts, 1);
    assert.equal(interruptedRecovery.last_error, "simulated interruption before publication");
    assert.equal(interruptedRecovery.payload.action, "organization.branding_updated");
    await sql.end({ timeout: 2 });
    sql = null;
    await current.stop();
    await current.dispose();
    current = await start();
    sql = postgres(current.databaseUrl, { max: 2, onnotice: () => {} });
    await sql.unsafe(
      "UPDATE organization_mutation_outbox SET next_attempt_at=now() WHERE id=$1::uuid",
      [interruptedRecovery.outbox_id],
    );
    let recoveredSnapshot = await readRecoverySnapshot();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      recoveredSnapshot = await readRecoverySnapshot();
      if (recoveredSnapshot.state === "published") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(recoveredSnapshot.state, "published");
    assert.ok(recoveredSnapshot.attempts >= 2);
    assert.equal(recoveredSnapshot.last_error, null);
    assert.deepEqual({
      idempotency_key: recoveredSnapshot.idempotency_key,
      activity_id: recoveredSnapshot.activity_id,
      outcome: recoveredSnapshot.outcome,
      action: recoveredSnapshot.action,
      activity_idempotency_key: recoveredSnapshot.activity_idempotency_key,
      outbox_id: recoveredSnapshot.outbox_id,
      event_type: recoveredSnapshot.event_type,
      payload: recoveredSnapshot.payload,
    }, {
      idempotency_key: interruptedRecovery.idempotency_key,
      activity_id: interruptedRecovery.activity_id,
      outcome: interruptedRecovery.outcome,
      action: interruptedRecovery.action,
      activity_idempotency_key: interruptedRecovery.activity_idempotency_key,
      outbox_id: interruptedRecovery.outbox_id,
      event_type: interruptedRecovery.event_type,
      payload: interruptedRecovery.payload,
    }, "restart recovery changed the receipt/activity/outbox identity or payload");

    console.log(JSON.stringify({
      marker: "RUST_BRANDING_REAL_ENTRY_PASS",
      instanceId,
      apiPort,
      databasePort,
      organizationId,
      unlistedOrganizationId,
      firstPatchStatus: patch.status,
      replayStatus: replay.status,
      auditFailureStatus: auditFailure.status,
      auditRetryStatus: auditRetry.status,
      cliStatus: cliResult.exitCode,
      mcpReplayStatus: mcpReplay.result.exitCode,
      crossTransportReplay: {
        owner: mcpReplayBrandingSnapshot.owner,
        mutationVersion: mcpReplayBrandingSnapshot.mutation_version,
        fenceEpoch: mcpReplayBrandingSnapshot.fence_epoch,
        receipts: mcpReplayBrandingSnapshot.receipt_count,
        activities: mcpReplayBrandingSnapshot.activity_count,
        outbox: mcpReplayBrandingSnapshot.outbox_count,
      },
      cliLogoLinkStatus: cliLogoLink.exitCode,
      missingLogoStatus: missingLogo.status,
      foreignLogoStatus: foreignLogo.status,
      mcpLogoLinkStatus: mcpLogoLink.result.exitCode,
      mcpLogoClearStatus: mcpLogoClear.result.exitCode,
      mcpBrandColorClearStatus: mcpBrandColorClear.result.exitCode,
      cliBrandColor: cliBody.brandColor,
      cliLogoAssetId: cliLogoBody.logoAssetId,
      mcpLogoAssetId: mcpLogoLink.organization?.logoAssetId,
      mcpBrandColorAfterLogoClear: mcpLogoClear.organization?.brandColor,
      mcpBrandColorAfterClear: mcpBrandColorClear.organization?.brandColor,
      state: stateRows[0],
      unlistedOwnerAfterRestart: unlistedRestartStateRows[0]?.owner,
      receipt: receiptRows[0],
      activityCount: activityRows.length,
      outbox: outboxRows[0],
      auditRetryEffect: auditRetryEffectRows?.[0],
      auditRetryReplayStatus: auditRetryReplay.status,
      outboxRecovery: {
        state: recoveredSnapshot.state,
        attempts: recoveredSnapshot.attempts,
        lastError: recoveredSnapshot.last_error,
        idempotencyKey: recoveredSnapshot.idempotency_key,
        activityId: recoveredSnapshot.activity_id,
        outboxId: recoveredSnapshot.outbox_id,
      },
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
