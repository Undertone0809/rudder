/** C slice: ordinary PATCH is Rust; every status=archived request remains Node.
 * Author verification uses an explicit candidate binary + hash; independent
 * acceptance runs only after stage review against the final immutable tuple.
 * Synthetic HTTP/cookie/JWT/PG/filesystem data only. No skips or provider calls. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDb } from "../../packages/db/src/index.js";
import { updateRunWorkspaceSchema } from "../../packages/shared/src/validators/execution-workspace.js";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../../server/src/agent-auth-jwt.js";
import { createBetterAuthHandler, createBetterAuthInstance, resolveBetterAuthSession } from "../../server/src/auth/better-auth.js";
import { actorMiddleware } from "../../server/src/middleware/auth.js";
import { boardMutationGuard } from "../../server/src/middleware/board-mutation-guard.js";
import { errorHandler } from "../../server/src/middleware/error-handler.js";
import { runWorkspaceRoutes } from "../../server/src/routes/execution-workspaces.js";
import { subscribeCompanyLiveEvents } from "../../server/src/services/live-events.js";
import { startOrganizationMutationOutboxPublisher } from "../../server/src/services/organization-mutation-outbox.js";
import { createRustActorEnvelope, createRustFoundationBridge, type RustFoundationBridge } from "../../server/src/services/rust-foundation-bridge.js";

const runFile = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "server/package.json"));
const dbRequire = createRequire(path.join(root, "packages/db/package.json"));
const express = require("express");
const postgres = dbRequire("postgres");
const { drizzle } = dbRequire("drizzle-orm/postgres-js");
const { migrate } = dbRequire("drizzle-orm/postgres-js/migrator");
const binary = process.env.RUDDER_ORDINARY_BINARY;
const hash = process.env.RUDDER_ORDINARY_BINARY_SHA256;
const reportPath = process.env.RUDDER_ORDINARY_REPORT;
const pgBin = process.env.RUDDER_POSTGRES_BIN_DIR;
assert.ok(binary && hash && reportPath && pgBin, "Explicit binary, hash, report and official PG path required");
assert.equal(createHash("sha256").update(await fs.readFile(binary)).digest("hex"), hash);
const pgVersion = (await runFile(path.join(pgBin, "postgres"), ["--version"])).stdout.trim();
assert.match(pgVersion, /18\.4\b/u);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-ordinary-public-"));
const cases: Array<{ name: string; status: "PASS" | "FAIL"; detail?: string }> = [];
const org = randomUUID(); const otherOrg = randomUUID(); const project = randomUUID();
const agent = randomUUID(); const otherAgent = randomUUID(); const agentKey = randomUUID();
const agentToken = `synthetic-agent-${randomUUID()}`; const otherAgentToken = `synthetic-agent-${randomUUID()}`;
const signingKey = "synthetic-workspace-ordinary-envelope-key-no-real-credentials";
let sql: any; let db: ReturnType<typeof createDb> | undefined; let server: any;
let bridge: RustFoundationBridge | undefined; let databaseUrl = ""; let startedPg = false; let base = "";
let member: { cookie: string; user: string }; let outsider: { cookie: string; user: string };
let rustCalls = 0;
const boundaryObservations: unknown[] = [];
let nativeUrl = ""; let nativeWireBytes = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith("/internal/run-workspace-ordinary-update")) {
    nativeUrl = url;
    nativeWireBytes = Buffer.byteLength(init?.body as Uint8Array);
  }
  return originalFetch(input, init);
};
process.env.BETTER_AUTH_SECRET = "synthetic-ordinary-cookie-secret-no-real-credentials";
process.env.RUDDER_AGENT_JWT_SECRET = "synthetic-ordinary-agent-secret-no-real-credentials";
process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = path.join(temp, "logs");
async function availablePort() {
  const listener = net.createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => listener.close(() => resolve())); return address.port;
}
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (!await check()) { assert.ok(Date.now() < deadline, `Timed out: ${label}`); await delay(20); }
}
async function saveReport() {
  await fs.writeFile(reportPath!, JSON.stringify({ scope: "ordinary PATCH only; explicit archived body stays Node; 0/2 complete handlers migrated", candidateBinary: binary,
    binarySha256: hash, postgres: pgVersion, synthetic: true, fixture: temp, publicBaseUrl: base, cases, boundaryObservations,
    passed: cases.filter((item) => item.status === "PASS").length, failed: cases.filter((item) => item.status === "FAIL").length, skipped: 0,
    limitations: ["Focused actual public router, real auth middleware, cookies, signed native bridge and PostgreSQL; unrelated app subsystems are not booted", "Legacy archive rm failure is narrowly injected on a real owned temporary directory; no OS disk fault is induced"],
  }, null, 2));
}
async function testcase(name: string, work: () => Promise<void>) {
  try { await work(); cases.push({ name, status: "PASS" }); console.log(`PASS ${name}`); }
  catch (error) { cases.push({ name, status: "FAIL", detail: error instanceof Error ? error.stack : String(error) }); console.error(`FAIL ${name}: ${String(error)}`); }
  await saveReport();
}
async function response(url: string, init: RequestInit = {}) {
  const result = await fetch(url, init); const rawBody = await result.text(); return { status: result.status, body: JSON.parse(rawBody) as any, rawBody, headers: result.headers };
}
async function patch(id: string, body: unknown, options: { alias?: string; cookie?: string; token?: string; run?: string } = {}) {
  return response(`${base}/api/${options.alias ?? "run-workspaces"}/${id}`, { method: "PATCH",
    headers: { "content-type": "application/json", origin: base,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : { cookie: options.cookie ?? member.cookie }),
      ...(options.run ? { "x-rudder-run-id": options.run } : {}) }, body: JSON.stringify(body) });
}
async function privateCommand(signed: Buffer, actual = signed) {
      const requestId = randomUUID(); const requestPath = "/internal/run-workspace-ordinary-update";
      const envelope = createRustActorEnvelope({ actor: { type: "board", source: "local_implicit", userId: "local-board", sessionId: "local-implicit" },
        organizationId: "run-workspace-ordinary-update", action: "run_workspace.ordinary_update", method: "POST", path: requestPath,
        body: signed, secret: signingKey, requestId });
      return response(nativeUrl, { method: "POST", headers: { "content-type": "application/json", "x-rudder-actor-envelope": JSON.stringify(envelope), "x-rudder-request-id": requestId }, body: actual as unknown as BodyInit });
}
async function signup(label: string) {
  const result = await response(`${base}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name: `Synthetic ${label}`, email: `${label}-${randomUUID()}@example.invalid`, password: "synthetic-only-workspace-password" }) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const cookie = result.headers.getSetCookie().find((value) => value.startsWith("better-auth.session_token="));
  assert.ok(cookie, "Real BetterAuth session cookie required");
  return { cookie: cookie.split(";", 1)[0]!, user: result.body.user.id as string };
}
async function membership(user: string) { await sql`INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES(${org},'user',${user},'member','active')`; }
async function workspace(options: { cwd?: string; status?: string; metadata?: unknown; provider?: string; branch?: string; projectWorkspace?: string } = {}) {
  const id = randomUUID(); await sql`INSERT INTO execution_workspaces(id,org_id,project_id,project_workspace_id,mode,strategy_type,name,status,cwd,provider_type,provider_ref,branch_name,metadata)
    VALUES(${id},${org},${project},${options.projectWorkspace ?? null},'isolated_workspace',${options.provider === "git_worktree" ? "git_worktree" : "project_primary"},'Synthetic ordinary workspace',${options.status ?? "active"},${options.cwd ?? null},${options.provider ?? "local_fs"},${options.provider === "git_worktree" ? options.cwd : null},${options.branch ?? null},${sql.json(options.metadata ?? { createdByRuntime: true })})`;
  return id;
}
async function directory(name: string) { const cwd = path.join(temp, name); await fs.mkdir(cwd, { recursive: true }); await fs.writeFile(path.join(cwd, "retained.txt"), name); return cwd; }
async function row(id: string) { return (await sql`SELECT * FROM execution_workspaces WHERE id=${id}`)[0]; }
async function audit(id: string) { return await sql`SELECT * FROM activity_log WHERE entity_id=${id} AND action='run_workspace.updated' ORDER BY created_at,id`; }
async function outbox(id: string) { return await sql`SELECT o.* FROM organization_mutation_outbox o JOIN activity_log a ON a.id=o.activity_id WHERE a.entity_id=${id}`; }
async function withRowLock(id: string, work: (unlock: () => Promise<void>) => Promise<void>) {
  const owner = await sql.reserve(); let released = false;
  await owner`BEGIN`; await owner`SELECT id FROM execution_workspaces WHERE id=${id} FOR UPDATE`;
  const unlock = async () => { if (!released) { released = true; await owner`COMMIT`; owner.release(); } };
  try { await work(unlock); } finally { await unlock(); }
}
async function waitForWorkspaceLock() { await until(async () => Number((await sql`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM execution_workspaces WHERE id=$1::uuid FOR UPDATE%'`)[0].count) > 0, "real Rust workspace row wait"); }
async function newRun() { const id = randomUUID(); await sql`INSERT INTO heartbeat_runs(id,org_id,agent_id,status) VALUES(${id},${org},${agent},'running')`; return id; }

try {
  const port = await availablePort();
  await runFile(path.join(pgBin, "initdb"), ["-D", path.join(temp, "pg"), "--auth=trust", "--username=postgres", "--encoding=UTF8", "--locale=C", "--no-sync"]);
  await runFile(path.join(pgBin, "pg_ctl"), ["-D", path.join(temp, "pg"), "-l", path.join(temp, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k '' -c shared_buffers=16MB`, "-w", "start"]);
  startedPg = true; databaseUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  const migrationSql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try { await migrate(drizzle(migrationSql), { migrationsFolder: path.join(root, "packages/db/src/migrations") }); }
  finally { await migrationSql.end(); }
  // Drizzle replaces a client's JSON serializers; keep raw fixture assertions
  // on their own unmodified postgres.js client.
  sql = postgres(databaseUrl, { max: 8, onnotice: () => {} }); db = createDb(databaseUrl);
  await sql`INSERT INTO organizations(id,name,url_key,issue_prefix) VALUES(${org},'Ordinary synthetic','ordinary-synthetic','ORD'),(${otherOrg},'Other synthetic','ordinary-other','OTH')`;
  await sql`INSERT INTO projects(id,org_id,name) VALUES(${project},${org},'Ordinary synthetic')`;
  await sql`INSERT INTO agents(id,org_id,name) VALUES(${agent},${org},'Synthetic agent'),(${otherAgent},${otherOrg},'Other agent')`;
  await sql`INSERT INTO agent_api_keys(id,agent_id,org_id,name,key_hash) VALUES(${agentKey},${agent},${org},'Synthetic',${createHash("sha256").update(agentToken).digest("hex")}),(${randomUUID()},${otherAgent},${otherOrg},'Synthetic other',${createHash("sha256").update(otherAgentToken).digest("hex")})`;
  bridge = createRustFoundationBridge({ databaseUrl, binaryPath: binary, actorEnvelopeKey: signingKey }); await bridge.start();
  const app = express(); server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const auth = createBetterAuthInstance(db, { authBaseUrlMode: "explicit", authPublicBaseUrl: base, authDisableSignUp: false } as any, [base]);
  app.all("/api/auth/*splat", createBetterAuthHandler(auth)); app.use(express.json({ limit: "10mb" }));
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: (req: any) => resolveBetterAuthSession(auth, req) })); app.use(boardMutationGuard());
  app.use("/api", runWorkspaceRoutes(db, { runWorkspaceOrdinaryUpdate: (...args: Parameters<NonNullable<RustFoundationBridge["runWorkspaceOrdinaryUpdate"]>>) => {
    rustCalls++; return bridge!.runWorkspaceOrdinaryUpdate!(...args);
  } } as RustFoundationBridge));
  app.use("/local-api", actorMiddleware(db, { deploymentMode: "local_trusted" }), runWorkspaceRoutes(db, bridge));
  app.use(errorHandler);
  member = await signup("member"); outsider = await signup("outsider"); await membership(member.user);

  for (const alias of ["run-workspaces", "execution-workspaces"]) {
    await testcase(`${alias}: ordinary cookie update, GET parity, activity and durable outbox`, async () => {
      const id = await workspace(); const body = { status: "idle", cleanupEligibleAt: "2024-02-29T12:13:14.1234567890123Z", cleanupReason: "Unicode 雪 ☃ 😀", metadata: { number: 9007199254740993, "$serde_json::private::RawValue": "literal", nested: [null, true, "雪"] } };
      const result = await patch(id, body, { alias }); assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.cleanupEligibleAt, "2024-02-29T12:13:14.123Z"); assert.deepEqual(result.body.metadata, body.metadata);
      const get = await response(`${base}/api/${alias}/${id}`, { headers: { cookie: member.cookie } }); assert.deepEqual(result.body, get.body);
      const activities = await audit(id); assert.equal(activities.length, 1); assert.equal(activities[0].actor_id, member.user);
      assert.deepEqual(activities[0].details.changedKeys, Object.keys(body).sort());
      const rows = await outbox(id); assert.equal(rows.length, 1); assert.equal(rows[0].state, "pending"); assert.equal(rows[0].payload.entityId, id);
      const events: any[] = []; const unsubscribe = subscribeCompanyLiveEvents(org, (event) => { if (event.payload.entityId === id) events.push(event); });
      const publisher = startOrganizationMutationOutboxPublisher(db!, { intervalMs: 60_000, batchSize: 500 });
      try { await publisher.drain(); await until(async () => (await outbox(id))[0].state === "published", "outbox delivery"); }
      finally { await publisher.close(); unsubscribe(); }
      assert.equal(events.length, 1); assert.equal(events[0].type, "activity.logged"); assert.deepEqual(events[0].payload, rows[0].payload);
    });
    await testcase(`${alias}: strict validation, missing/forbidden/cross-org and malformed UUID precedence`, async () => {
      const id = await workspace(); const before = await row(id); const missing = randomUUID();
      assert.equal((await patch(missing, { unexpected: true }, { alias, cookie: outsider.cookie })).status, 400);
      assert.equal((await patch(missing, {}, { alias, cookie: outsider.cookie })).status, 404);
      assert.equal((await patch(id, {}, { alias, cookie: outsider.cookie })).status, 403);
      assert.equal((await patch(id, {}, { alias, token: otherAgentToken })).status, 403);
      assert.equal((await patch(id, {}, { alias, cookie: "" })).status, 401);
      assert.equal((await patch("not-a-uuid", {}, { alias })).status, 500);
      assert.deepEqual(await row(id), before); assert.equal((await audit(id)).length, 0); assert.equal((await outbox(id)).length, 0);
    });
    await testcase(`${alias}: same-org Agent, empty patch, nulls and ordinary update of archived row`, async () => {
      const id = await workspace({ status: "archived" }); const result = await patch(id, { status: "active", cleanupReason: null, cleanupEligibleAt: null, metadata: null }, { alias, token: agentToken });
      assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.status, "active"); assert.equal(result.body.metadata, null);
      assert.equal((await patch(id, {}, { alias })).status, 200); const activities = await audit(id); assert.equal(activities.length, 2); assert.equal(activities[0].actor_type, "agent"); assert.equal(activities[0].agent_id, agent); assert.deepEqual(activities[1].details.changedKeys, []);
    });
    await testcase(`${alias}: unchanged Node first/repeated archive and active linked issue 409`, async () => {
      const cwd = await directory(`${alias}-archive`); const sibling = await directory(`${alias}-archive-sibling`); const id = await workspace({ cwd }); const issue = randomUUID();
      await sql`INSERT INTO issues(id,org_id,project_id,title,status,execution_workspace_id) VALUES(${issue},${org},${project},'Synthetic linked','todo',${id})`;
      const calls = rustCalls; assert.equal((await patch(id, { status: "archived" }, { alias })).status, 409);
      await sql`UPDATE issues SET status='done' WHERE id=${issue}`;
      const result = await patch(id, { status: "archived" }, { alias }); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.status, "archived");
      await assert.rejects(fs.stat(cwd), { code: "ENOENT" }); assert.equal(await fs.readFile(path.join(sibling, "retained.txt"), "utf8"), `${alias}-archive-sibling`);
      const closed = (await row(id)).closed_at;
      assert.equal((await patch(id, { status: "archived", cleanupReason: "repeat note" }, { alias })).status, 200); assert.deepEqual((await row(id)).closed_at, closed); assert.equal((await row(id)).cleanup_reason, "repeat note"); assert.equal((await audit(id)).length, 2); assert.equal(rustCalls, calls);
      assert.equal((await outbox(id)).length, 0, "Legacy Node archive emits its existing direct live event");
    });
  }

  for (const alias of ["run-workspaces", "execution-workspaces"]) {
    for (const [label, value] of [["isolated high", "\ud800"], ["isolated low", "\udfff"], ["pair", "\ud83d\ude00"], ["literal backslash", "\\ud800"]]) {
      await testcase(`${alias}: wire TEXT ${label} matches Node and PostgreSQL`, async () => {
        const legacy = await workspace({ status: "archived" }); const native = await workspace();
        const before = { legacy: await row(legacy), native: await row(native) };
        const left = await patch(legacy, { status: "archived", cleanupReason: value }, { alias });
        const right = await patch(native, { cleanupReason: value }, { alias });
        const after = { legacy: await row(legacy), native: await row(native) };
        boundaryObservations.push({ alias, label, left, right, before, after, audits: [(await audit(legacy)).length, (await audit(native)).length], outboxes: [(await outbox(legacy)).length, (await outbox(native)).length] });
        const expected = Buffer.from(value!, "utf8").toString("utf8");
        assert.equal(left.status, 200); assert.equal(right.status, 200);
        assert.equal(after.legacy.cleanup_reason, expected); assert.equal(after.native.cleanup_reason, expected);
        assert.equal(left.body.cleanupReason, expected); assert.equal(right.body.cleanupReason, expected);
        assert.equal((await audit(native)).length, 1); assert.equal((await outbox(native)).length, 1);
        assert.deepEqual((await audit(native))[0].details.changedKeys, ["cleanupReason"]);
      });
    }
    for (const [label, metadata, status] of [
      ["high value", { value: "\ud800" }, 500], ["low value", { value: "\udfff" }, 500],
      ["high key", { ["\ud800"]: "retained" }, 500], ["literal escape", { value: "\\ud800" }, 200],
      ["valid pair", { value: "\ud83d\ude00" }, 200], ["null", null, 200], ["empty object", {}, 200],
    ] as const) {
      await testcase(`${alias}: wire metadata ${label} matches Node JSONB outcome`, async () => {
        const legacy = await workspace({ status: "archived" }); const native = await workspace();
        const before = { legacy: await row(legacy), native: await row(native) };
        const left = await patch(legacy, { status: "archived", metadata }, { alias });
        const right = await patch(native, { metadata }, { alias });
        const after = { legacy: await row(legacy), native: await row(native) };
        const counts = { audits: [(await audit(legacy)).length, (await audit(native)).length], outboxes: [(await outbox(legacy)).length, (await outbox(native)).length] };
        boundaryObservations.push({ alias, label, left, right, before, after, ...counts });
        if (left.status !== 200) { assert.deepEqual(after.legacy, before.legacy); assert.equal(counts.audits[0], 0); assert.equal(counts.outboxes[0], 0); }
        if (right.status !== 200) { assert.deepEqual(after.native, before.native); assert.equal(counts.audits[1], 0); assert.equal(counts.outboxes[1], 0); }
        assert.equal(left.status, status); assert.equal(right.status, status);
        if (status === 200) {
          assert.deepEqual(after.native.metadata, metadata); assert.deepEqual(right.body.metadata, metadata);
          assert.equal(counts.audits[1], 1); assert.equal(counts.outboxes[1], 1);
          assert.deepEqual((await audit(native))[0].details.changedKeys, ["metadata"]);
        }
      });
    }
    await testcase(`${alias}: malformed metadata preserves missing and cross-org authority precedence`, async () => {
      const id = await workspace(); const before = await row(id); const metadata = { bad: "\ud800" };
      const missing = await patch(randomUUID(), { metadata }, { alias, cookie: outsider.cookie });
      const forbidden = await patch(id, { metadata }, { alias, cookie: outsider.cookie });
      const crossOrg = await patch(id, { metadata }, { alias, token: otherAgentToken });
      const invalid = await patch(id, { metadata, unknown: true }, { alias });
      boundaryObservations.push({ alias, label: "metadata error precedence", missing, forbidden, crossOrg, invalid, before, after: await row(id), audit: await audit(id), outbox: await outbox(id) });
      assert.deepEqual(await row(id), before); assert.equal((await audit(id)).length, 0); assert.equal((await outbox(id)).length, 0);
      assert.equal(missing.status, 404); assert.equal(forbidden.status, 403); assert.equal(crossOrg.status, 403); assert.equal(invalid.status, 400);
    });
  }

  const deepPayload = '"metadata":{"value":' + '['.repeat(8192) + '0' + ']'.repeat(8192) + '}';
  for (const alias of ["run-workspaces", "execution-workspaces"]) {
    for (const scenario of ["existing", "missing", "forbidden"] as const) {
      await testcase(`${alias}: raw depth8192 metadata ${scenario} preserves legacy error precedence`, async () => {
        const legacy = scenario === "missing" ? randomUUID() : await workspace({ status: "archived" });
        const native = scenario === "missing" ? randomUUID() : await workspace();
        const before = { legacy: await row(legacy) ?? null, native: await row(native) ?? null };
        const cookie = scenario === "forbidden" ? outsider.cookie : member.cookie;
        const send = (id: string, body: string) => response(`${base}/api/${alias}/${id}`, { method: "PATCH", headers: { "content-type": "application/json", origin: base, cookie }, body });
        const left = await send(legacy, '{"status":"archived",' + deepPayload + '}');
        const right = await send(native, '{' + deepPayload + '}');
        const after = { legacy: await row(legacy) ?? null, native: await row(native) ?? null };
        const counts = { audits: [(await audit(legacy)).length, (await audit(native)).length], outboxes: [(await outbox(legacy)).length, (await outbox(native)).length] };
        boundaryObservations.push({ alias, label: "public serialization depth", scenario, depth: 8192, publicBytes: Buffer.byteLength(deepPayload) + 2, left, right, before, after, ...counts });
        assert.deepEqual(after, before); assert.deepEqual(counts.audits, [0, 0]); assert.deepEqual(counts.outboxes, [0, 0]);
        const expected = scenario === "existing" ? 500 : scenario === "missing" ? 404 : 403;
        assert.equal(left.status, expected); assert.equal(right.status, expected);
      });
    }
  }
  await testcase("deep metadata failure rechecks membership after a real row wait", async () => {
    const actor = await signup("deep-wait"); await membership(actor.user);
    const id = await workspace(); const before = await row(id);
    await withRowLock(id, async (unlock) => {
      const pending = response(`${base}/api/run-workspaces/${id}`, { method: "PATCH", headers: { "content-type": "application/json", origin: base, cookie: actor.cookie }, body: '{' + deepPayload + '}' });
      await waitForWorkspaceLock(); await sql`DELETE FROM organization_memberships WHERE org_id=${org} AND principal_id=${actor.user}`;
      await unlock(); const result = await pending;
      boundaryObservations.push({ label: "deep metadata row-wait revocation", result, before, after: await row(id), audit: Array.from(await audit(id)), outbox: Array.from(await outbox(id)) });
      assert.deepEqual(await row(id), before); assert.equal((await audit(id)).length, 0); assert.equal((await outbox(id)).length, 0); assert.equal(result.status, 403);
    });
  });
  await testcase("private serialization-failure fact enforces strict shape and signature binding", async () => {
    const id = await workspace(); const before = await row(id);
    const variants = [
      { input: { metadata: null }, metadataSerializationFailed: false },
      { input: { metadata: null }, metadataSerializationFailed: null },
      { input: { metadata: null }, metadataSerializationFailed: "true" },
      { input: { metadata: null }, metadataSerializationFailed: 1 },
      { input: { metadata: {} }, metadataSerializationFailed: true },
      { input: {}, metadataSerializationFailed: true },
      { metadataSerializationFailed: true },
      { input: { metadata: null }, metadataSerializationFailed: true, metadataJsonBase64: "e30=" },
      { input: { status: "archived", metadata: null }, metadataSerializationFailed: true },
    ];
    const results = [];
    for (const variant of variants) {
      const result = await privateCommand(Buffer.from(JSON.stringify({ id, localImplicit: true, ...variant })));
      results.push({ variant, result });
    }
    const signed = Buffer.from(JSON.stringify({ id, localImplicit: true, input: { metadata: null }, metadataSerializationFailed: true }));
    const tampered = Buffer.from(signed.toString().replace('"metadataSerializationFailed":true', '"metadataSerializationFailed":false'));
    const badSignature = await privateCommand(signed, tampered);
    boundaryObservations.push({ label: "private serialization-failure fact", results, badSignature, before, after: await row(id), audit: Array.from(await audit(id)), outbox: Array.from(await outbox(id)) });
    assert.deepEqual(await row(id), before); assert.equal((await audit(id)).length, 0); assert.equal((await outbox(id)).length, 0);
    for (const { result } of results) assert.equal(result.status, 400);
    assert.equal(badSignature.status, 401);
    assert.equal((await patch(id, { metadata: { shallowControl: true } })).status, 200);
  });
  await testcase("dense exponent metadata exceeds old 20 MiB wire cap through actual public HTTP", async () => {
    const id = await workspace(); const count = 1_100_000;
    const publicBody = '{"metadata":{"values":[' + "1e20,".repeat(count - 1) + "1e20]}}";
    assert.equal(Buffer.byteLength(publicBody), 5_500_025); assert.ok(Buffer.byteLength(publicBody) < 10 * 1024 * 1024);
    const listing = (await runFile("ps", ["-eo", "pid,args"])).stdout.split("\n");
    const nativeProcess = listing.find((line) => line.trim().split(/\s+/u)[1] === binary);
    assert.ok(nativeProcess, "Live owned native candidate process"); const nativePid = Number(nativeProcess.trim().split(/\s+/u)[0]);
    let peakNativeRssKiB = 0; let peakHostRss = process.memoryUsage().rss;
    const sample = async () => {
      const status = await fs.readFile(`/proc/${nativePid}/status`, "utf8");
      peakNativeRssKiB = Math.max(peakNativeRssKiB, Number(status.match(/^VmRSS:\s+(\d+)/mu)?.[1] ?? 0));
      peakHostRss = Math.max(peakHostRss, process.memoryUsage().rss);
    };
    await sample(); const timer = setInterval(() => { void sample().catch(() => undefined); }, 25);
    try {
      const result = await response(`${base}/api/run-workspaces/${id}`, { method: "PATCH", headers: { "content-type": "application/json", origin: base, cookie: member.cookie }, body: publicBody });
      const wireBytes = nativeWireBytes; await sample();
      assert.equal(result.status, 200, result.rawBody.slice(0, 200)); assert.ok(wireBytes > 20 * 1024 * 1024); assert.ok(wireBytes < 80 * 1024 * 1024);
      assert.equal(result.body.metadata.values.length, count); assert.equal(result.body.metadata.values[0], 1e20); assert.equal(result.body.metadata.values.at(-1), 1e20);
      const persisted = (await sql`SELECT jsonb_array_length(metadata->'values') AS count, metadata->'values'->0 AS first, metadata->'values'->-1 AS last FROM execution_workspaces WHERE id=${id}`)[0];
      assert.equal(persisted.count, count); assert.equal(persisted.first, 1e20); assert.equal(persisted.last, 1e20);
      assert.equal((await audit(id)).length, 1); assert.equal((await outbox(id)).length, 1);
      boundaryObservations.push({ label: "dense exponent", publicBytes: Buffer.byteLength(publicBody), wireBytes, nativePid, peakNativeRssKiB, peakHostRss, status: result.status, persisted, audit: (await audit(id)).length, outbox: (await outbox(id)).length, nativeStillAlive: true });
    } finally { clearInterval(timer); }
    assert.equal((await patch(await workspace(), {})).status, 200, "Native still serves following request");
  });
  await testcase("private sidecar tamper and 80 MiB overflow reject with no database effects", async () => {
    const id = await workspace(); const before = await row(id); assert.ok(nativeUrl);
    const signed = Buffer.from(JSON.stringify({ id, input: { metadata: null }, metadataJsonBase64: Buffer.from("{}").toString("base64"), localImplicit: true }));
    const tampered = Buffer.from(signed.toString().replace("e30=", "bnVsbA=="));
    const badSignature = await privateCommand(signed, tampered);
    const excessive = Buffer.from(JSON.stringify({ id, input: { cleanupReason: "x".repeat(80 * 1024 * 1024) }, localImplicit: true }));
    const tooLarge = await privateCommand(excessive);
    boundaryObservations.push({ label: "private limits and binding", signedBytes: signed.length, excessiveBytes: excessive.length, badSignature, tooLarge, before, after: await row(id), audit: await audit(id), outbox: await outbox(id) });
    assert.deepEqual(await row(id), before); assert.equal((await audit(id)).length, 0); assert.equal((await outbox(id)).length, 0);
    assert.equal(badSignature.status, 401); assert.equal(tooLarge.status, 413);
    assert.equal((await patch(await workspace(), {})).status, 200);
  });
  await testcase("exact local implicit Board exception and authenticated instance admin", async () => {
    const local = await workspace();
    const result = await response(`${base}/local-api/run-workspaces/${local}`, { method: "PATCH", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ status: "idle" }) });
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal((await audit(local))[0].actor_id, "local-board");
    const admin = await signup("instance-admin"); await sql`INSERT INTO instance_user_roles(user_id,role) VALUES(${admin.user},'instance_admin')`;
    const id = await workspace(); assert.equal((await patch(id, {}, { cookie: admin.cookie })).status, 200);
    await withRowLock(id, async (unlock) => {
      const pending = patch(id, { status: "idle" }, { cookie: admin.cookie }); await waitForWorkspaceLock();
      await sql`DELETE FROM instance_user_roles WHERE user_id=${admin.user}`; await unlock(); assert.equal((await pending).status, 403);
    });
    assert.equal((await row(id)).status, "active"); assert.equal((await audit(id)).length, 1);
  });
  await testcase("public 10 MiB contract accepts 2 MiB metadata and nesting beyond serde defaults", async () => {
    const id = await workspace(); let nested: unknown = { leaf: "retained" };
    for (let index = 0; index < 160; index++) nested = { child: nested };
    const metadata = { large: "x".repeat(2 * 1024 * 1024), nested };
    const result = await patch(id, { metadata }); assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 200));
    assert.deepEqual(result.body.metadata, metadata); assert.deepEqual((await row(id)).metadata, metadata);
    assert.equal((await audit(id)).length, 1); assert.equal((await outbox(id)).length, 1);
  });
  await testcase("body above public 10 MiB limit is rejected before native dispatch", async () => {
    const id = await workspace(); const before = await row(id); const calls = rustCalls;
    // Existing errorHandler maps body-parser's size error to 500; preserve that
    // inherited response instead of silently changing this slice to 413.
    assert.equal((await patch(id, { metadata: { large: "x".repeat(10 * 1024 * 1024) } })).status, 500);
    assert.equal(rustCalls, calls); assert.deepEqual(await row(id), before); assert.equal((await audit(id)).length, 0);
  });
  const oracleBodies: unknown[] = [
    { cleanupEligibleAt: "2024-02-29T12:34Z" }, { cleanupEligibleAt: "2024-02-29T12:34:56Z" },
    { cleanupEligibleAt: "2024-02-29T12:34:56.123999999999999999999Z" }, { cleanupEligibleAt: "2000-02-29T00:00:00Z" },
    { cleanupEligibleAt: "1900-02-29T00:00:00Z" }, { cleanupEligibleAt: "2023-02-29T00:00:00Z" },
    { cleanupEligibleAt: "2024-04-31T00:00:00Z" }, { cleanupEligibleAt: "2024-02-29T12:34:56+00:00" },
    { cleanupEligibleAt: "2024-02-29T12:34:60Z" }, { cleanupEligibleAt: null }, {},
    { metadata: [] }, { metadata: "invalid" }, { metadata: null }, { metadata: { "\u2028雪": "😀", values: [1e100, 1e-100, null] } },
    { metadata: {}, metadataSerializationFailed: true },
    { status: "idle", unknown: 1 }, { archiveRecovery: "abandon", status: "active" }, [], null,
  ];
  for (const [index, input] of oracleBodies.entries()) {
    await testcase(`shared Zod/Date oracle ${index + 1}: ${JSON.stringify(input)}`, async () => {
      const expected = updateRunWorkspaceSchema.safeParse(input); const id = await workspace(); const before = await row(id);
      // Strict express.json rejects a root null before Zod; the existing public
      // error handler maps that parser failure to 500.
      const result = await patch(id, input); assert.equal(result.status, input === null ? 500 : expected.success ? 200 : 400, JSON.stringify(result.body));
      if (expected.success) {
        if (expected.data.cleanupEligibleAt) assert.equal(result.body.cleanupEligibleAt, new Date(expected.data.cleanupEligibleAt).toISOString());
        assert.equal((await audit(id)).length, 1);
      } else { assert.deepEqual(await row(id), before); assert.equal((await audit(id)).length, 0); }
    });
  }
  for (const target of ["activity_log", "organization_mutation_outbox"]) {
    await testcase(`${target} real PostgreSQL rejection rolls back workspace, audit and outbox`, async () => {
      const id = await workspace(); const before = await row(id);
      const predicate = target === "activity_log" ? `NEW.entity_id = '${id}'` : `NEW.payload->>'entityId' = '${id}'`;
      await sql.unsafe(`CREATE FUNCTION synthetic_ordinary_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${predicate} THEN RAISE EXCEPTION 'synthetic ordinary persistence failure'; END IF; RETURN NEW; END $$`);
      await sql.unsafe(`CREATE TRIGGER synthetic_ordinary_reject BEFORE INSERT ON ${target} FOR EACH ROW EXECUTE FUNCTION synthetic_ordinary_reject()`);
      try {
        assert.equal((await patch(id, { metadata: { mustRollback: true } })).status, 500);
        assert.deepEqual(await row(id), before); assert.equal((await audit(id)).length, 0); assert.equal((await outbox(id)).length, 0);
      } finally { await sql.unsafe(`DROP TRIGGER synthetic_ordinary_reject ON ${target}`); await sql`DROP FUNCTION synthetic_ordinary_reject()`; }
    });
  }
  await testcase("concurrent ordinary updates serialize without losing unrelated fields", async () => {
    const id = await workspace(); const responses = await Promise.all([patch(id, { status: "in_review" }), patch(id, { metadata: { concurrent: true } })]);
    assert.deepEqual(responses.map((item) => item.status), [200, 200]); assert.equal((await row(id)).status, "in_review"); assert.deepEqual((await row(id)).metadata, { concurrent: true }); assert.equal((await audit(id)).length, 2); assert.equal((await outbox(id)).length, 2);
  });
  for (const mutation of ["membership-revoke", "cookie-revoke", "cookie-rebind", "cookie-expire"] as const) {
    await testcase(`actual BetterAuth cookie ${mutation} during real row lock wait`, async () => {
      const user = await signup(mutation); await membership(user.user); const session = (await sql`SELECT id FROM session WHERE user_id=${user.user}`)[0].id;
      const id = await workspace(); const before = await row(id);
      await withRowLock(id, async (unlock) => {
        const pending = patch(id, { status: "idle" }, { cookie: user.cookie }); await waitForWorkspaceLock();
        if (mutation === "membership-revoke") await sql`UPDATE organization_memberships SET status='suspended' WHERE org_id=${org} AND principal_id=${user.user}`;
        if (mutation === "cookie-revoke") await sql`DELETE FROM session WHERE id=${session}`;
        if (mutation === "cookie-rebind") await sql`UPDATE session SET user_id=${outsider.user} WHERE id=${session}`;
        if (mutation === "cookie-expire") { await sql`UPDATE session SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=${session}`; await until(async () => (await sql`SELECT expires_at<=clock_timestamp() AS expired FROM session WHERE id=${session}`)[0].expired, "natural cookie expiry"); }
        await unlock(); assert.equal((await pending).status, mutation === "membership-revoke" ? 403 : 401);
      });
      assert.deepEqual(await row(id), before); assert.equal((await audit(id)).length, 0); assert.equal((await outbox(id)).length, 0);
    });
  }
  for (const kind of ["agent-key-revoke", "board-key-revoke", "board-key-expire"] as const) {
    await testcase(`${kind} during real row lock wait`, async () => {
      const token = `synthetic-wait-${randomUUID()}`; const keyId = randomUUID(); const digest = createHash("sha256").update(token).digest("hex");
      if (kind === "agent-key-revoke") await sql`INSERT INTO agent_api_keys(id,agent_id,org_id,name,key_hash) VALUES(${keyId},${agent},${org},'Synthetic wait',${digest})`;
      else await sql`INSERT INTO board_api_keys(id,user_id,name,key_hash) VALUES(${keyId},${member.user},'Synthetic wait',${digest})`;
      const id = await workspace(); const before = await row(id);
      await withRowLock(id, async (unlock) => {
        const pending = patch(id, { metadata: { forbidden: true } }, { token }); await waitForWorkspaceLock();
        if (kind === "agent-key-revoke") await sql`UPDATE agent_api_keys SET revoked_at=clock_timestamp() WHERE id=${keyId}`;
        else if (kind === "board-key-revoke") await sql`UPDATE board_api_keys SET revoked_at=clock_timestamp() WHERE id=${keyId}`;
        else { await sql`UPDATE board_api_keys SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=${keyId}`; await until(async () => (await sql`SELECT expires_at<=clock_timestamp() AS expired FROM board_api_keys WHERE id=${keyId}`)[0].expired, "natural Board key expiry"); }
        await unlock(); assert.equal((await pending).status, 401);
      });
      assert.deepEqual(await row(id), before); assert.equal((await audit(id)).length, 0);
    });
  }
  await testcase("actual Agent JWT expires while native waits, then authentic JWT and run attribution succeed", async () => {
    const run = await newRun(); const id = await workspace(); const before = await row(id);
    process.env.RUDDER_AGENT_JWT_TTL_SECONDS = "2";
    const token = createLocalAgentJwt(agent, org, "synthetic", run); assert.ok(token); const claims = verifyLocalAgentJwt(token); assert.ok(claims);
    try {
      await withRowLock(id, async (unlock) => {
        const pending = patch(id, { status: "idle" }, { token }); await waitForWorkspaceLock();
        await until(async () => Date.now() >= claims.exp * 1000, "real JWT expiry"); await unlock(); assert.equal((await pending).status, 401);
      });
    } finally { delete process.env.RUDDER_AGENT_JWT_TTL_SECONDS; }
    assert.deepEqual(await row(id), before); assert.equal((await audit(id)).length, 0);
    const fresh = createLocalAgentJwt(agent, org, "synthetic", run); assert.ok(fresh);
    assert.equal((await patch(id, { status: "idle" }, { token: fresh })).status, 200); assert.equal((await audit(id))[0].run_id, run);
  });
  for (const mutation of ["agent-org", "run-agent"] as const) {
    await testcase(`signed Agent JWT ${mutation} rebind during row wait is denied`, async () => {
      const run = await newRun(); const token = createLocalAgentJwt(agent, org, "synthetic", run); assert.ok(token);
      const id = await workspace(); const before = await row(id);
      try {
        await withRowLock(id, async (unlock) => {
          const pending = patch(id, { status: "idle" }, { token }); await waitForWorkspaceLock();
          if (mutation === "agent-org") await sql`UPDATE agents SET org_id=${otherOrg} WHERE id=${agent}`;
          else await sql`UPDATE heartbeat_runs SET agent_id=${otherAgent},org_id=${otherOrg} WHERE id=${run}`;
          await unlock(); assert.equal((await pending).status, mutation === "agent-org" ? 401 : 403);
        });
        assert.deepEqual(await row(id), before); assert.equal((await audit(id)).length, 0); assert.equal((await outbox(id)).length, 0);
      } finally { await sql`UPDATE agents SET org_id=${org} WHERE id=${agent}`; }
    });
  }
  await testcase("credential revoked during activity trigger wait rolls back the earlier update", async () => {
    const user = await signup("audit-wait"); await membership(user.user); const id = await workspace(); const before = await row(id);
    const owner = await sql.reserve(); await owner`SELECT pg_advisory_lock(72572,111)`;
    await sql.unsafe(`CREATE FUNCTION synthetic_ordinary_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_id='${id}' THEN PERFORM pg_advisory_xact_lock(72572,111); END IF; RETURN NEW; END $$`);
    await sql`CREATE TRIGGER synthetic_ordinary_wait BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION synthetic_ordinary_wait()`;
    let pending: Promise<any> | undefined;
    try {
      pending = patch(id, { metadata: { mustRollback: true } }, { cookie: user.cookie });
      await until(async () => Number((await sql`SELECT count(*) FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'INSERT INTO activity_log%'`)[0].count) > 0, "actual activity insertion wait");
      await sql`DELETE FROM session WHERE user_id=${user.user}`; await owner`SELECT pg_advisory_unlock_all()`;
      assert.equal((await pending).status, 401); assert.deepEqual(await row(id), before); assert.equal((await audit(id)).length, 0); assert.equal((await outbox(id)).length, 0);
    } finally {
      await owner`SELECT pg_advisory_unlock_all()`; owner.release(); if (pending) await pending;
      await sql`DROP TRIGGER synthetic_ordinary_wait ON activity_log`; await sql`DROP FUNCTION synthetic_ordinary_wait()`;
    }
  });
  await testcase("legacy Node archive cleanup_failed and thrown cleanup contracts remain", async () => {
    const retained = await directory("node-retained"); const id = await workspace({ cwd: retained, metadata: { createdByRuntime: false } });
    const calls = rustCalls; const result = await patch(id, { status: "archived" }); assert.equal(result.status, 200); assert.equal(result.body.status, "cleanup_failed"); assert.ok(await fs.stat(retained));
    const failing = await directory("node-rm-failure"); const failedId = await workspace({ cwd: failing }); const remove = fs.rm;
    fs.rm = (async (target: Parameters<typeof fs.rm>[0], options: Parameters<typeof fs.rm>[1]) => {
      if (String(target) === failing) throw Object.assign(new Error("synthetic owned-directory removal failure"), { code: "EIO" });
      return remove(target, options);
    }) as typeof fs.rm;
    try { const failure = await patch(failedId, { status: "archived" }); assert.equal(failure.status, 500); assert.equal((await row(failedId)).status, "cleanup_failed"); assert.equal((await audit(failedId)).length, 0); }
    finally { fs.rm = remove; }
    assert.equal(rustCalls, calls);
  });
  await testcase("native outage: ordinary updates never fall back; first and repeated Node archives still work", async () => {
    await bridge!.close(); bridge = createRustFoundationBridge({ databaseUrl, binaryPath: path.join(temp, "missing-native"), actorEnvelopeKey: signingKey });
    try {
      for (const alias of ["run-workspaces", "execution-workspaces"]) {
        const active = await workspace(); const archived = await workspace({ status: "archived" });
        for (const id of [active, archived]) { const before = await row(id); assert.equal((await patch(id, { cleanupReason: "must not persist" }, { alias })).status, 503); assert.deepEqual(await row(id), before); assert.equal((await audit(id)).length, 0); }
        const calls = rustCalls; assert.equal((await patch(active, { status: "archived" }, { alias })).status, 200); assert.equal((await patch(active, { status: "archived" }, { alias })).status, 200); assert.equal((await audit(active)).length, 2); assert.equal(rustCalls, calls);
      }
    } finally { await bridge.close(); bridge = createRustFoundationBridge({ databaseUrl, binaryPath: binary, actorEnvelopeKey: signingKey }); await bridge.start(); }
    const id = await workspace(); assert.equal((await patch(id, { metadata: { restarted: true } })).status, 200);
  });
} catch (error) {
  cases.push({ name: "fixture setup or unexpected harness failure", status: "FAIL", detail: error instanceof Error ? error.stack : String(error) });
  throw error;
} finally {
  globalThis.fetch = originalFetch;
  if (bridge) await bridge.close().catch(() => undefined);
  if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  if (db) await (db as any).$client.end({ timeout: 2 });
  if (sql) await sql.end({ timeout: 2 });
  if (startedPg) await runFile(path.join(pgBin, "pg_ctl"), ["-D", path.join(temp, "pg"), "-m", "immediate", "-w", "stop"]);
  await saveReport();
  if (cases.length && cases.every((item) => item.status === "PASS")) await fs.rm(temp, { recursive: true, force: true });
  else console.error(`Failed fixture retained: ${temp}`);
}
assert.equal(cases.filter((item) => item.status === "FAIL").length, 0, "Inspect retained evidence for failed cases");
console.log(JSON.stringify({ passed: cases.length, failed: 0, skipped: 0, reportPath }));
