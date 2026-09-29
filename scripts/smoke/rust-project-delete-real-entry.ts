import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdtemp, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run only after the parent releases the serialized local PostgreSQL slot:
// node cli/node_modules/tsx/dist/cli.mjs scripts/smoke/rust-project-delete-real-entry.ts
// Requires the current foundation + migration-preflight binaries and DB build.
// This is source real-entry evidence, not installed-package acceptance.
type Json = Record<string, any>;
type Reply = { status: number; body: Json };
type Fixture = { id: string; goalId: string; resourceId: string; before: Json };
type ServerHandle = Awaited<ReturnType<typeof import("../../server/src/index.js").startServer>>;

export function assertLegacyDeleteResponse(response: Json, before: Json, legacy: Json) {
  assert.deepEqual(Object.keys(response).sort(), Object.keys(legacy).sort(), "DELETE response keys drifted from Node");
  for (const key of Object.keys(legacy)) {
    assert.ok(Object.hasOwn(before, key), `GET fixture lacks legacy field ${key}`);
    assert.deepEqual(response[key], before[key], `DELETE changed legacy field ${key}`);
  }
}

export function assertDeleteReceipt(receipts: Json[], projectId: string, response: Json) {
  assert.equal(receipts.length, 1, "expected exactly one durable delete receipt");
  const receipt = receipts[0];
  assert.equal(receipt.command_kind, "project_delete");
  assert.equal(receipt.outcome, "applied");
  assert.equal(receipt.result.result.kind, "project_deleted");
  assert.equal(receipt.result.result.project_id, projectId);
  assert.deepEqual(receipt.result.result.response, response);
  assert.match(receipt.activity_id, /^[0-9a-f-]{36}$/u);
}

export function ownedFoundationPids(processListing: string, parentPid: number, binaryPath: string): number[] {
  return processListing.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    return match && Number(match[2]) === parentPid
      && (match[3] === binaryPath || match[3].startsWith(`${binaryPath} `))
      ? [Number(match[1])] : [];
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForExit(pid: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`owned foundation child ${pid} did not exit`);
}

async function main() {
  assert.notEqual(process.platform, "win32", "this source smoke uses POSIX process ownership inspection");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const requireFromDb = createRequire(path.join(repoRoot, "packages/db/package.json"));
  const postgres = requireFromDb("postgres");
  const { drizzle } = requireFromDb("drizzle-orm/postgres-js");
  const home = await mkdtemp(path.join(os.tmpdir(), "rudder-rust-project-delete-"));
  const originalEnv = { ...process.env };
  const binaryPath = path.join(home, "rudder-server-foundation");
  const apiPort = await availablePort();
  const databasePort = await availablePort();
  let current: ServerHandle | null = null;
  let sql: any = null;
  const selected = new Set<string>();
  const evidence: Json = {};
  try {
    await copyFile(originalEnv.RUDDER_SERVER_FOUNDATION_PATH
      ?? path.join(repoRoot, "native/target/debug/rudder-server-foundation"), binaryPath);
    await chmod(binaryPath, 0o755);
    for (const key of Object.keys(process.env)) if (key.startsWith("RUDDER_")) delete process.env[key];
    Object.assign(process.env, {
      DATABASE_URL: "",
      RUDDER_HOME: home,
      RUDDER_INSTANCE_ID: `project-delete-${process.pid}`,
      RUDDER_AGENT_JWT_SECRET: randomUUID(),
      RUDDER_EMBEDDED_POSTGRES_PORT: String(databasePort),
      RUDDER_MIGRATION_AUTO_APPLY: "true",
      RUDDER_MIGRATION_PROMPT: "never",
      RUDDER_NATIVE_MODE: "required",
      RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH: originalEnv.RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH
        ?? path.join(repoRoot, "native/target/debug/migration-preflight"),
      RUDDER_SERVER_FOUNDATION_PATH: binaryPath,
      RUDDER_NATIVE_ACTOR_ENVELOPE_KEY: randomUUID(),
      RUDDER_DEPLOYMENT_MODE: "local_trusted",
      RUDDER_RUST_MEMBER_DIRECTORY_MODE: "off",
      RUDDER_RUST_ORGANIZATION_BRANDING_MODE: "off",
      RUDDER_RUST_PROJECT_GOAL_SET_MODE: "required",
      RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS: "",
      RUDDER_OPEN_ON_LISTEN: "false",
    });
    const { startServer } = await import("../../server/src/index.js");
    const stop = async () => {
      await sql?.end({ timeout: 2 });
      sql = null;
      if (current) {
        await current.stop();
        await current.dispose();
        current = null;
      }
    };
    const start = async () => {
      process.env.RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS = [...selected].join(",");
      current = await startServer({
        runtimeOwnerKind: "server", openOnListen: false, printBanner: false,
        runtimeOverrides: {
          host: "127.0.0.1", port: apiPort, serveUi: false, uiDevMiddleware: false,
          heartbeatSchedulerEnabled: false, databaseBackupEnabled: false,
        },
      });
      sql = postgres(current.databaseUrl, { max: 2, onnotice: () => {} });
    };
    const request = async (url: string, method = "GET", body?: Json, headers: Record<string, string> = {}): Promise<Reply> => {
      const response = await fetch(`${current!.apiUrl}/api${url}`, {
        method, headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
      return { status: response.status, body: await response.json() as Json };
    };
    const create = async (url: string, body: Json) => {
      const response = await request(url, "POST", body);
      assert.equal(response.status, 201, JSON.stringify(response));
      assert.match(response.body.id, /^[0-9a-f-]{36}$/u);
      return response.body;
    };
    const agentContexts = new Map<string, string>();
    const remove = (id: string, key?: string, token?: string) => {
      const agentId = token ? agentContexts.get(token) : undefined;
      if (token) assert.ok(agentId, "agent fixture must provide its explicit request context");
      return request(`/projects/${id}`, "DELETE", undefined, {
        ...(key ? { "x-rudder-idempotency-key": key } : {}),
        // Local-trusted mode intentionally permits implicit board access.
        // Bind agent fixtures to the supported context header so an invalid
        // or terminated key cannot be interpreted as an implicit board request.
        ...(token ? { authorization: `Bearer ${token}`, "x-rudder-agent-id": agentId! } : {}),
      });
    };
    await start();
    const org = await create("/orgs", { name: "Project deletion ownership", issuePrefix: "RPD", requireBoardApprovalForNewAgents: false });
    const foreignOrg = await create("/orgs", { name: "Project deletion foreign scope", issuePrefix: "RPF", requireBoardApprovalForNewAgents: false });
    const fixture = async (name: string, description = "Deletion parity fixture"): Promise<Fixture> => {
      const goal = await create(`/orgs/${org.id}/goals`, { title: `${name} goal` });
      const project = await create(`/orgs/${org.id}/projects`, { name, goalIds: [goal.id], description });
      const resource = await create(`/orgs/${org.id}/resources`, {
        name: `${name} reference`, kind: "url", sourceType: "external", locator: `https://example.test/${project.id}`,
      });
      await create(`/projects/${project.id}/resources`, { resourceId: resource.id, role: "reference", isPrimary: true });
      const before = await request(`/projects/${project.id}`);
      assert.equal(before.status, 200);
      return { id: project.id, goalId: goal.id, resourceId: resource.id, before: before.body };
    };
    const agent = async (orgId: string, name: string) => {
      const value = await create(`/orgs/${orgId}/agents`, {
        name, role: "engineer", agentRuntimeType: "process", agentRuntimeConfig: {},
      });
      const key = await request(`/agents/${value.id}/keys`, "POST", { name });
      assert.equal(key.status, 201);
      assert.match(key.body.token, /^pcp_[a-f0-9]{48}$/u);
      agentContexts.set(key.body.token, value.id);
      return { id: value.id, token: key.body.token as string };
    };
    const engineer = await agent(org.id, "Deletion engineer");
    const outsider = await agent(foreignOrg.id, "Foreign engineer");
    const inactive = await agent(org.id, "Inactive engineer");
    await sql.unsafe("UPDATE agents SET status = 'terminated' WHERE id = $1", [inactive.id]);
    const legacy = await fixture("Legacy response baseline");
    const mainProject = await fixture("Selected linked project");
    const largeProject = await fixture("Large legacy response", "x".repeat(1152 * 1024));
    const noKey = await fixture("Generated idempotency key");
    const rollback = await fixture("Atomic audit failure");
    const conflict = await fixture("Conflicting command target");
    const outage = await fixture("Foundation outage");
    const nodeOnly = await fixture("Unlisted Node project");
    const unlistedRust = await fixture("Rust ownership outside active allowlist");
    const legacyIssueProject = await fixture("Node project referenced by Issue");
    const rustIssueProject = await fixture("Rust project referenced by Issue");
    const issueReferences = new Map<string, string>();
    for (const f of [legacyIssueProject, rustIssueProject]) {
      const issue = await create(`/orgs/${org.id}/issues`, {
        title: "Keep this Issue and its Project reference", projectId: f.id,
      });
      assert.equal(issue.projectId, f.id);
      issueReferences.set(f.id, issue.id);
    }
    const legacyDenied = await remove(legacy.id, undefined, outsider.token);
    const legacyInactive = await remove(legacy.id, undefined, inactive.token);
    assert.equal(legacyDenied.status, 403);
    assert.equal(legacyInactive.status, 401);
    const legacyDeleted = await remove(legacy.id, undefined, engineer.token);
    assert.equal(legacyDeleted.status, 200, JSON.stringify(legacyDeleted));
    assertLegacyDeleteResponse(legacyDeleted.body, legacy.before, legacyDeleted.body);
    assert.equal((await remove(legacy.id)).status, 404);

    for (const f of [mainProject, largeProject, noKey, rollback, conflict, outage, unlistedRust, rustIssueProject]) selected.add(f.id);
    await stop();
    await start();
    const states = await sql.unsafe("SELECT project_id::text, owner FROM project_goal_mutation_state WHERE org_id = $1", [org.id]);
    for (const id of selected) assert.equal(states.find((row: Json) => row.project_id === id)?.owner, "rust");
    assert.equal(states.find((row: Json) => row.project_id === nodeOnly.id)?.owner, "node");
    // On the later restart, this remains Rust-owned but is outside the active allowlist.
    selected.delete(unlistedRust.id);

    const snapshot = async (f: Fixture) => {
      const [rows] = await sql.unsafe(`SELECT
        (SELECT to_jsonb(p) FROM projects p WHERE id = $1) AS project,
        (SELECT to_jsonb(s) FROM project_goal_mutation_state s WHERE project_id = $1) AS fence,
        (SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY goal_id), '[]') FROM project_goals g WHERE project_id = $1) AS goals,
        (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id), '[]') FROM project_resource_attachments a WHERE project_id = $1) AS attachments,
        (SELECT count(*)::int FROM activity_log WHERE entity_id = $1::text AND action = 'project.deleted') AS audits,
        (SELECT count(*)::int FROM organization_mutation_receipts WHERE org_id = $2 AND result->'result'->>'project_id' = $1::text AND command_kind = 'project_delete') AS receipts,
        (SELECT count(*)::int FROM organization_mutation_outbox o JOIN activity_log a ON a.id = o.activity_id WHERE a.entity_id = $1::text AND a.action = 'project.deleted') AS outbox`, [f.id, org.id]);
      return rows;
    };
    const assertDeleted = async (f: Fixture, response: Json) => {
      assert.deepEqual(await snapshot(f), { project: null, fence: null, goals: [], attachments: [], audits: 1, receipts: 1, outbox: 1 });
      const receipts = await sql.unsafe("SELECT command_kind, outcome, activity_id::text, result FROM organization_mutation_receipts WHERE org_id = $1 AND command_kind = 'project_delete' AND result->'result'->>'project_id' = $2", [org.id, f.id]);
      assertDeleteReceipt(receipts, f.id, response);
      const outboxRows = await sql.unsafe("SELECT event_type, payload->>'action' AS action FROM organization_mutation_outbox WHERE org_id = $1 AND activity_id = $2", [org.id, receipts[0].activity_id]);
      assert.deepEqual(Array.from(outboxRows), [{ event_type: "activity.logged", action: "project.deleted" }]);
      const [remaining] = await sql.unsafe("SELECT (SELECT count(*)::int FROM goals WHERE id = $1) AS goals, (SELECT count(*)::int FROM organization_resources WHERE id = $2) AS resources", [f.goalId, f.resourceId]);
      assert.deepEqual(remaining, { goals: 1, resources: 1 });
      return receipts[0];
    };
    // An existing Issue prevents deletion through the same non-cascading FK
    // on both authorities. Exercise the public DELETE, not a SQL-only failure.
    const referencedSnapshot = async (f: Fixture) => ({
      ...await snapshot(f),
      issue: (await sql.unsafe("SELECT to_jsonb(i) AS row FROM issues i WHERE id = $1 AND org_id = $2", [issueReferences.get(f.id), org.id]))[0]?.row,
    });
    const legacyIssueBefore = await referencedSnapshot(legacyIssueProject);
    const rustIssueBefore = await referencedSnapshot(rustIssueProject);
    assert.equal(legacyIssueBefore.fence.owner, "node");
    assert.equal(rustIssueBefore.fence.owner, "rust");
    for (const [f, before] of [[legacyIssueProject, legacyIssueBefore], [rustIssueProject, rustIssueBefore]] as const) {
      assert.equal(before.issue.project_id, f.id);
      assert.equal(before.goals.length, 1);
      assert.equal(before.attachments.length, 1);
      assert.deepEqual([before.audits, before.receipts, before.outbox], [0, 0, 0]);
    }
    const legacyIssueFailure = await remove(legacyIssueProject.id);
    assert.equal(legacyIssueFailure.status, 500, JSON.stringify(legacyIssueFailure));
    assert.deepEqual(await referencedSnapshot(legacyIssueProject), legacyIssueBefore);
    const rustIssueFailure = await remove(rustIssueProject.id, `issue-reference-${rustIssueProject.id}`);
    assert.equal(rustIssueFailure.status, legacyIssueFailure.status, JSON.stringify(rustIssueFailure));
    assert.deepEqual(await referencedSnapshot(rustIssueProject), rustIssueBefore,
      "Issue-reference failure changed Project, fence, links, attachments, Issue, audit, receipt or outbox");
    evidence.issueReferenceFailure = {
      legacyStatus: legacyIssueFailure.status, rustStatus: rustIssueFailure.status,
      projectId: rustIssueProject.id, issueId: issueReferences.get(rustIssueProject.id),
    };
    const beforeDenied = await snapshot(mainProject);
    assert.equal((await remove(mainProject.id, "foreign-denied", outsider.token)).status, legacyDenied.status);
    assert.equal((await remove(mainProject.id, "inactive-denied", inactive.token)).status, legacyInactive.status);
    assert.deepEqual(await snapshot(mainProject), beforeDenied);

    // Sequences are non-transactional: a rolled-back Node DELETE still trips this counter.
    await sql.unsafe("CREATE SEQUENCE smoke_project_delete_attempts");
    await sql.unsafe("CREATE FUNCTION smoke_count_project_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('smoke_project_delete_attempts'); RETURN OLD; END $$");
    await sql.unsafe("CREATE TRIGGER smoke_count_project_delete BEFORE DELETE ON projects FOR EACH ROW EXECUTE FUNCTION smoke_count_project_delete()");
    const attempts = async () => (await sql.unsafe("SELECT last_value::text, is_called FROM smoke_project_delete_attempts"))[0];
    const { projectService } = await import("../../server/src/services/projects.js");
    const beforeStale = await attempts();
    await assert.rejects(projectService(drizzle(sql) as never).remove(mainProject.id), /owned by Rust/i);
    assert.deepEqual(await attempts(), beforeStale, "stale Node remove reached DELETE");
    assert.deepEqual(await snapshot(mainProject), beforeDenied);

    const largeKey = `large-${largeProject.id}`;
    const largeDeleted = await remove(largeProject.id, largeKey);
    assert.equal(largeDeleted.status, 200);
    assertLegacyDeleteResponse(largeDeleted.body, largeProject.before, legacyDeleted.body);
    assert.ok(Buffer.byteLength(JSON.stringify(largeDeleted.body)) > 1024 * 1024);
    assert.deepEqual(await remove(largeProject.id, largeKey), largeDeleted);
    await assertDeleted(largeProject, largeDeleted.body);
    evidence.largeResponseBytes = Buffer.byteLength(JSON.stringify(largeDeleted.body));

    const key = `delete-${mainProject.id}`;
    // Hold delivery eligibility, not transaction writes, across the restart.
    await sql.unsafe("CREATE FUNCTION smoke_hold_delete_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->>'action' = 'project.deleted' THEN NEW.next_attempt_at := now() + interval '1 day'; END IF; RETURN NEW; END $$");
    await sql.unsafe("CREATE TRIGGER smoke_hold_delete_event BEFORE INSERT ON organization_mutation_outbox FOR EACH ROW EXECUTE FUNCTION smoke_hold_delete_event()");
    const deleted = await remove(mainProject.id, key, engineer.token);
    assert.equal(deleted.status, 200, JSON.stringify(deleted));
    assertLegacyDeleteResponse(deleted.body, mainProject.before, legacyDeleted.body);
    const receipt = await assertDeleted(mainProject, deleted.body);
    const pendingEvent = async () => (await sql.unsafe("SELECT id::text, state, attempts, published_at FROM organization_mutation_outbox WHERE activity_id = $1", [receipt.activity_id]))[0];
    const heldEvent = await pendingEvent();
    assert.deepEqual(heldEvent, { id: heldEvent.id, state: "pending", attempts: 0, published_at: null });
    const [actor] = await sql.unsafe("SELECT actor_type, actor_id, agent_id::text FROM activity_log WHERE id = $1", [receipt.activity_id]);
    assert.deepEqual(actor, { actor_type: "agent", actor_id: engineer.id, agent_id: engineer.id });
    const attemptsAfterDelete = await attempts();
    assert.deepEqual(await remove(mainProject.id, key, engineer.token), deleted);
    assert.deepEqual(await attempts(), attemptsAfterDelete, "same-key replay executed another DELETE");
    assert.equal((await remove(mainProject.id)).status, 404);
    const beforeConflict = await snapshot(conflict);
    assert.equal((await remove(conflict.id, key, engineer.token)).status, 409);
    assert.deepEqual(await snapshot(conflict), beforeConflict);
    assert.equal((await remove(mainProject.id, key, outsider.token)).status, 403);
    await sql.unsafe("UPDATE agents SET status = 'terminated' WHERE id = $1", [engineer.id]);
    assert.equal((await remove(mainProject.id, key, engineer.token)).status, 401);
    await sql.unsafe("UPDATE agents SET status = 'idle' WHERE id = $1", [engineer.id]);
    await assertDeleted(mainProject, deleted.body);

    const generated = await remove(noKey.id);
    assert.equal(generated.status, 200, JSON.stringify(generated));
    assertLegacyDeleteResponse(generated.body, noKey.before, legacyDeleted.body);
    await assertDeleted(noKey, generated.body);
    assert.equal((await remove(noKey.id)).status, 404);

    const rollbackBefore = await snapshot(rollback);
    const organizationBefore = await sql.unsafe("SELECT * FROM organization_mutation_state WHERE org_id = $1", [org.id]);
    await sql.unsafe("CREATE SEQUENCE smoke_project_delete_audit_failures");
    await sql.unsafe("CREATE FUNCTION smoke_fail_project_delete_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'project.deleted' THEN PERFORM nextval('smoke_project_delete_audit_failures'); RAISE EXCEPTION 'forced project delete audit failure'; END IF; RETURN NEW; END $$");
    await sql.unsafe("CREATE TRIGGER smoke_fail_project_delete_audit BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION smoke_fail_project_delete_audit()");
    const rollbackKey = `rollback-${rollback.id}`;
    try {
      assert.equal((await remove(rollback.id, rollbackKey)).status, 500);
      assert.deepEqual((await sql.unsafe("SELECT last_value::text, is_called FROM smoke_project_delete_audit_failures"))[0], { last_value: "1", is_called: true }, "request did not reach the forced audit failure");
      assert.deepEqual(await snapshot(rollback), rollbackBefore, "audit failure did not roll back deletion, fence, links, receipt and outbox");
      assert.deepEqual(await sql.unsafe("SELECT * FROM organization_mutation_state WHERE org_id = $1", [org.id]), organizationBefore);
    } finally {
      await sql.unsafe("DROP TRIGGER smoke_fail_project_delete_audit ON activity_log");
      await sql.unsafe("DROP FUNCTION smoke_fail_project_delete_audit()");
      await sql.unsafe("DROP SEQUENCE smoke_project_delete_audit_failures");
    }
    const retried = await remove(rollback.id, rollbackKey);
    assert.equal(retried.status, 200, JSON.stringify(retried));
    await assertDeleted(rollback, retried.body);
    // Preserve terminal IDs exactly as an operator's original allowlist would.
    const deletedAllowlistIds = [mainProject.id, noKey.id, rollback.id];
    for (const id of deletedAllowlistIds) assert.ok(selected.has(id));
    const unknownId = randomUUID();
    const [unknownState] = await sql.unsafe("SELECT (SELECT count(*)::int FROM projects WHERE id = $1) AS projects, (SELECT count(*)::int FROM organization_mutation_receipts WHERE command_kind = 'project_delete' AND result->'result'->>'project_id' = $1::text) AS receipts", [unknownId]);
    assert.deepEqual(unknownState, { projects: 0, receipts: 0 });
    await stop();
    selected.add(unknownId);
    try {
      await assert.rejects(start(), "an arbitrary missing allowlist ID without a delete receipt must fail startup");
    } finally {
      selected.delete(unknownId);
    }
    await start();
    assert.equal((await request("/health")).status, 200, "restart with receipt-backed deleted allowlist IDs failed");
    const restartedAllowlist = process.env.RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS!.split(",");
    for (const id of deletedAllowlistIds) assert.ok(restartedAllowlist.includes(id));
    await assertDeleted(noKey, generated.body);
    await assertDeleted(rollback, retried.body);
    const unlistedBefore = await snapshot(unlistedRust);
    assert.equal(unlistedBefore.fence.owner, "rust");
    assert.equal((await remove(unlistedRust.id, "unlisted-rust-owned")).status, 503);
    assert.deepEqual(await snapshot(unlistedRust), unlistedBefore, "unlisted Rust-owned deletion reached Node");
    const attemptsAfterRestart = await attempts();
    assert.deepEqual(await remove(mainProject.id, key, engineer.token), deleted, "receipt replay failed after row/fence deletion and restart");
    assert.deepEqual(await attempts(), attemptsAfterRestart, "restart replay executed another DELETE");
    await assertDeleted(mainProject, deleted.body);
    assert.equal((await remove(noKey.id)).status, 404, "unkeyed repeat changed after restart");
    // Reusing the UUID must not let a historical receipt delete a newly created row.
    await sql.unsafe("INSERT INTO projects (id, org_id, name) VALUES ($1, $2, 'Recreated UUID sentinel')", [mainProject.id, org.id]);
    const recreatedBefore = await snapshot(mainProject);
    assert.deepEqual(await remove(mainProject.id, key, engineer.token), deleted);
    assert.deepEqual(await snapshot(mainProject), recreatedBefore, "receipt replay mutated a recreated Project UUID");

    assert.deepEqual(await pendingEvent(), heldEvent, "held event did not survive restart unchanged");
    const requireFromServer = createRequire(path.join(repoRoot, "server/package.json"));
    const { WebSocket } = requireFromServer("ws");
    const socket = new WebSocket(`${current!.apiUrl.replace(/^http/u, "ws")}/api/orgs/${org.id}/events/ws`);
    const received: Json[] = [];
    socket.on("message", (data: Buffer) => received.push(JSON.parse(data.toString())));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("outbox WebSocket connection timed out")), 10_000);
        socket.once("open", () => { clearTimeout(timer); resolve(); });
        socket.once("error", (error: Error) => { clearTimeout(timer); reject(error); });
      });
      await sql.unsafe("UPDATE organization_mutation_outbox SET next_attempt_at = now() WHERE id = $1", [heldEvent.id]);
      let delivered: Json | undefined;
      let published: Json | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        delivered = received.find((event) => event.dedupeKey === `organization-mutation-outbox:${heldEvent.id}`);
        published = await pendingEvent();
        if (delivered && published?.state === "published") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(delivered, "restarted outbox did not deliver its event over public WebSocket");
      assert.equal(delivered.orgId, org.id);
      assert.equal(delivered.type, "activity.logged");
      assert.equal(delivered.payload.action, "project.deleted");
      assert.equal(published?.state, "published");
      assert.ok(published?.published_at);
      assert.equal(published?.attempts, 1);
      assert.deepEqual(await snapshot(mainProject), recreatedBefore, "outbox recovery changed recreated Project or durable command counts");
      evidence.outboxRecovery = { id: heldEvent.id, state: published.state, attempts: published.attempts, event: delivered };
    } finally {
      socket.terminate();
    }

    // The binary is a disposable copy; never rename or kill another worker's artifact/process.
    const listing = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
    const children = ownedFoundationPids(listing, process.pid, binaryPath);
    assert.equal(children.length, 1, "expected exactly one owned Rust foundation child");
    await rename(binaryPath, `${binaryPath}.disabled`);
    process.kill(children[0], "SIGKILL");
    await waitForExit(children[0]);
    const outageBefore = await snapshot(outage);
    const attemptsBefore = await attempts();
    for (let retry = 0; retry < 2; retry += 1) {
      assert.equal((await remove(outage.id, `outage-${outage.id}`)).status, 503);
    }
    assert.equal((await request("/health")).status, 200);
    assert.deepEqual(await attempts(), attemptsBefore, "Rust outage attempted a fallback DELETE");
    assert.deepEqual(await snapshot(outage), outageBefore);
    // Outside the selected boundary, ordinary Node-owned deletion still works during outage.
    const nodeDeleted = await remove(nodeOnly.id);
    assert.equal(nodeDeleted.status, 200);
    assertLegacyDeleteResponse(nodeDeleted.body, nodeOnly.before, legacyDeleted.body);
    evidence.projectId = mainProject.id;
    evidence.activityId = receipt.activity_id;
    evidence.idempotencyKey = key;
    evidence.restartWithDeletedAllowlistIds = deletedAllowlistIds;
    evidence.unknownAllowlistIdRejected = unknownId;
    evidence.organizationId = org.id;
    evidence.ownedFoundationPid = children[0];
    evidence.cliDelete = "absent from current project command registry";
    evidence.mcpDelete = "absent from current agent contract";
    await stop();
    console.log(JSON.stringify({ marker: "RUST_PROJECT_DELETE_REAL_ENTRY_PASS", ...evidence }));
  } finally {
    const cleanupErrors: unknown[] = [];
    try { await sql?.end({ timeout: 2 }); } catch (error) { cleanupErrors.push(error); }
    // The nested start/stop closures own assignment; retain their current handle for cleanup.
    const remaining = current as ServerHandle | null;
    if (remaining) {
      try { await remaining.stop(); } catch (error) { cleanupErrors.push(error); }
      try { await remaining.dispose(); } catch (error) { cleanupErrors.push(error); }
    }
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `Smoke cleanup failed; disposable data retained at ${home}`);
    await rm(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
