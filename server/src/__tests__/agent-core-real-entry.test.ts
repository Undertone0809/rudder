/** Synthetic PostgreSQL and the source-built foundation, through production routers/auth. */
import { applyPendingMigrations, createDb, ensurePostgresDatabase } from "@rudderhq/db";
import { createAgentKeySchema, resetAgentSessionSchema, RUDDER_BROWSER_MCP_TOOL_NAMES, RUDDER_CORE_MCP_TOOL_NAMES, updateAgentPermissionsSchema } from "@rudderhq/shared";
import { sql } from "drizzle-orm";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureOrganizationWorkspaceLayout, resolveOrganizationAgentsDir, resolveOrganizationWorkspaceHomeDir, resolveRudderInstanceRoot } from "../home-paths.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { validate } from "../middleware/validate.js";
import { omitSecretPayloadFields, redactEventPayload } from "../redaction.js";
import { agentRoutes } from "../routes/agents.js";
import { agentService } from "../services/agents.js";
import { configureBrowserCapabilityDeployment } from "../services/browser-capability.js";
import { startOrganizationMutationOutboxPublisher } from "../services/organization-mutation-outbox.js";
import { createRustFoundationBridge, type RustFoundationActor, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";
type Pg = {
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
};
async function port() { const server = net.createServer().listen(0, "127.0.0.1"); await once(server, "listening"); const value = (server.address() as net.AddressInfo).port; await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); return value; }
async function stop(server?: Server) { if (server)
    await new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeAllConnections(); }); }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const foundationBinaryName = process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation";
function resolveFoundationBinary(repo: string, env: NodeJS.ProcessEnv = process.env) {
    const targetDir = path.resolve(repo, env.CARGO_TARGET_DIR ?? "native/target");
    const explicit = env.RUDDER_SERVER_FOUNDATION_PATH?.trim();
    const candidates = explicit ? [path.resolve(repo, explicit)] : [
        path.join(targetDir, "debug", foundationBinaryName), path.join(targetDir, "release", foundationBinaryName),
    ];
    const binary = candidates.find((candidate) => {
        try {
            fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
            return fs.statSync(candidate).isFile();
        }
        catch { return false; }
    });
    if (!binary)
        throw new Error(`Agent core requires an executable foundation binary. Checked: ${candidates.join(", ")}`);
    return binary;
}
describe("Agent core foundation binary resolution", () => {
    let repo = "";
    beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-agent-core-binary-")); });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });
    function fixtureBinary(relative: string) {
        const binary = path.join(repo, relative, foundationBinaryName);
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.writeFileSync(binary, "fixture", { mode: 0o755 });
        return binary;
    }
    it("resolves a release-only build in the default target directory", () => {
        const release = fixtureBinary("native/target/release");
        expect(resolveFoundationBinary(repo, {})).toBe(release);
    });
    it("resolves a release-only build in relative and absolute Cargo target directories", () => {
        const release = fixtureBinary("custom-target/release");
        for (const target of ["custom-target", path.join(repo, "custom-target")])
            expect(resolveFoundationBinary(repo, { CARGO_TARGET_DIR: target })).toBe(release);
    });
    it("prefers debug when both default build profiles are executable files", () => {
        fixtureBinary("native/target/release");
        const debug = fixtureBinary("native/target/debug");
        expect(resolveFoundationBinary(repo, {})).toBe(debug);
    });
    it("honors relative and absolute explicit paths ahead of build profiles", () => {
        fixtureBinary("native/target/debug");
        const explicit = fixtureBinary("selected");
        for (const selected of [path.relative(repo, explicit), explicit])
            expect(resolveFoundationBinary(repo, { RUDDER_SERVER_FOUNDATION_PATH: ` ${selected} ` })).toBe(explicit);
    });
    it("fails closed for an explicit missing path even when both build profiles exist", () => {
        fixtureBinary("native/target/debug");
        fixtureBinary("native/target/release");
        const missing = path.join(repo, "missing", foundationBinaryName);
        expect(() => resolveFoundationBinary(repo, { RUDDER_SERVER_FOUNDATION_PATH: missing })).toThrow(missing);
    });
    it("rejects directories and skips an unusable debug candidate", () => {
        const debug = path.join(repo, "native/target/debug", foundationBinaryName);
        fs.mkdirSync(debug, { recursive: true });
        const release = fixtureBinary("native/target/release");
        expect(resolveFoundationBinary(repo, {})).toBe(release);
        expect(() => resolveFoundationBinary(repo, { RUDDER_SERVER_FOUNDATION_PATH: debug })).toThrow(debug);
    });
    it("checks platform access for both build candidates and explicit paths", () => {
        const debug = fixtureBinary("native/target/debug");
        fs.chmodSync(debug, 0o600);
        const release = fixtureBinary("native/target/release");
        expect(resolveFoundationBinary(repo, {})).toBe(process.platform === "win32" ? debug : release);
        const explicit = () => resolveFoundationBinary(repo, { RUDDER_SERVER_FOUNDATION_PATH: debug });
        if (process.platform === "win32")
            expect(explicit()).toBe(debug);
        else
            expect(explicit).toThrow(debug);
    });
});
describe("Agent core fifteen-route real HTTP authority", () => {
    let db: ReturnType<typeof createDb>;
    let pg: Pg | undefined;
    let root = "";
    let server: Server | undefined;
    let bridge: RustFoundationBridge | undefined;
    let binary = "";
    let databaseUrl = "";
    let nodeUrl = "";
    let publicUrl = "";
    const org = randomUUID(), otherOrg = randomUUID(), agent = randomUUID(), peer = randomUUID(), foreignAgent = randomUUID(), revision = randomUUID();
    const owner = `agent-core-owner-${randomUUID()}`, other = `agent-core-peer-${randomUUID()}`, outsider = `agent-core-outsider-${randomUUID()}`;
    const ownerToken = `synthetic-board-${randomUUID()}`, otherToken = `synthetic-board-${randomUUID()}`, outsiderToken = `synthetic-board-${randomUUID()}`, agentToken = `synthetic-agent-${randomUUID()}`;
    const publicRun = randomUUID(), privateRun = randomUUID(), privateChat = randomUUID();
    const snapshot = { name: "Delta restored", role: "engineer", title: null, capabilities: null, agentRuntimeType: "process", agentRuntimeConfig: { opaque: "h.p.s", env: { VISIBLE: { type: "plain", value: "ordinary" }, API_TOKEN: { type: "secret_ref", secretId: randomUUID(), version: "latest" } }, nested: { password: "synthetic-only", keep: ["h.p.s", { "$serde_json::private::Number": "literal" }] } }, runtimeConfig: { heartbeat: { enabled: "yes", intervalSec: "0x3c" } }, budgetMonthlyCents: 0, metadata: { nested: { "$serde_json::private::RawValue": "not parsed" } } };
    function call(base: string, method: "get" | "post" | "delete" | "patch", url: string, token = ownerToken, input?: unknown) { let r = request(base)[method](url); if (token)
        r = r.set("authorization", `Bearer ${token}`); if (input !== undefined)
        r = r.send(input); return r; }
    async function scalar(query: ReturnType<typeof sql>) { const rows = await db.execute(query); return Number(rows[0]?.value ?? 0); }
    beforeAll(async () => {
        const repo = fileURLToPath(new URL("../../../", import.meta.url));
        binary = resolveFoundationBinary(repo);
        console.info("Agent core source binary", { sha256: createHash("sha256").update(fs.readFileSync(binary)).digest("hex"), binary });
        root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-agent-core-http-"));
        const PgConstructor = (await import("embedded-postgres")).default;
        const dbPort = await port();
        pg = new PgConstructor({ databaseDir: root, user: "rudder", password: "synthetic", port: dbPort, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], postgresFlags: ["-c", "unix_socket_directories=", "-c", "dynamic_shared_memory_type=mmap", "-c", "shared_buffers=16MB", "-c", "max_connections=24"], onLog: () => { }, onError: () => { } });
        await pg.initialise();
        await pg.start();
        await ensurePostgresDatabase(`postgres://rudder:synthetic@127.0.0.1:${dbPort}/postgres`, "rudder");
        databaseUrl = `postgres://rudder:synthetic@127.0.0.1:${dbPort}/rudder`;
        await applyPendingMigrations(databaseUrl);
        db = createDb(databaseUrl);
        for (const [id, name, prefix] of [[org, "Agent core", "AC"], [otherOrg, "Foreign", "FC"]]) {
            await db.execute(sql `INSERT INTO organizations(id,name,url_key,issue_prefix) VALUES(${id}::uuid,${name},${id},${prefix})`);
            await db.execute(sql `INSERT INTO organization_mutation_state(org_id,owner,fence_epoch) VALUES(${id}::uuid,'rust',7) ON CONFLICT(org_id) DO NOTHING`);
        }
        for (const [id, name, token, orgId] of [[owner, "Owner", ownerToken, org], [other, "Peer", otherToken, org], [outsider, "Outside", outsiderToken, otherOrg]]) {
            await db.execute(sql `INSERT INTO "user"(id,name,email,created_at,updated_at) VALUES(${id},${name},${id + "@example.test"},now(),now())`);
            await db.execute(sql `INSERT INTO organization_memberships(org_id,principal_type,principal_id,status,membership_role) VALUES(${orgId}::uuid,'user',${id},'active','member')`);
            await db.execute(sql `INSERT INTO board_api_keys(user_id,name,key_hash) VALUES(${id},'synthetic',${hash(token!)})`);
        }
        await db.execute(sql `INSERT INTO instance_user_roles(user_id,role) VALUES(${owner},'instance_admin')`);
        await db.execute(sql `INSERT INTO agents(id,org_id,name,role,status,permissions,agent_runtime_config,runtime_config,workspace_key) VALUES(${agent}::uuid,${org}::uuid,'Delta agent','engineer','idle','{"canCreateAgents":false,"canManageSkills":true}',${JSON.stringify(snapshot.agentRuntimeConfig)}::jsonb,${JSON.stringify(snapshot.runtimeConfig)}::jsonb,'stable-agent-key'),(${peer}::uuid,${org}::uuid,'Peer agent','ceo','idle','{}','{}','{}','peer-key'),(${foreignAgent}::uuid,${otherOrg}::uuid,'Foreign agent','general','idle','{}','{}','{}','foreign-key')`);
        await db.execute(sql `INSERT INTO agent_api_keys(org_id,agent_id,name,key_hash) VALUES(${org}::uuid,${agent}::uuid,'synthetic runtime',${hash(agentToken)})`);
        await db.execute(sql `INSERT INTO agent_config_revisions(id,org_id,agent_id,before_config,after_config,changed_keys) VALUES(${revision}::uuid,${org}::uuid,${agent}::uuid,${JSON.stringify(snapshot)}::jsonb,${JSON.stringify({ ...snapshot, agentRuntimeConfig: { opaque: "ordinary", array: ["h.p.s", { keep: "literal" }] } })}::jsonb,'["name"]')`);
        await db.execute(sql `INSERT INTO chat_conversations(id,org_id,title,conversation_kind,created_by_user_id,status,side_chat_state) VALUES(${privateChat}::uuid,${org}::uuid,'Private peer','side_chat',${other},'resolved','completed')`);
        await db.execute(sql `INSERT INTO heartbeat_runs(id,org_id,agent_id,status,context_snapshot,chat_conversation_id) VALUES(${publicRun}::uuid,${org}::uuid,${agent}::uuid,'succeeded','{}',NULL),(${privateRun}::uuid,${org}::uuid,${agent}::uuid,'running','{"scene":"side_chat"}',${privateChat}::uuid)`);
        await db.execute(sql `INSERT INTO issues(org_id,title,status,priority,assignee_agent_id,execution_run_id) VALUES(${org}::uuid,'Synthetic inbox issue','todo','high',${agent}::uuid,${privateRun}::uuid)`);
        const app = express();
        app.use(express.json({ limit: "10mb" }));
        app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
        app.use(actorMiddleware(db, { deploymentMode: "authenticated", authRequirement: "required" }));
        server = app.listen(0, "127.0.0.1");
        await once(server, "listening");
        nodeUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
        bridge = createRustFoundationBridge({ databaseUrl, binaryPath: binary, mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off", actorEnvelopeKey: "synthetic-agent-foundation-key-32-bytes", publicIngress: { listenAddr: `127.0.0.1:${await port()}`, nodeUpstream: nodeUrl, authorizationKey: "synthetic-public-ingress-key-32-bytes" } });
        configureBrowserCapabilityDeployment(db, "local_trusted");
        app.use("/api", agentRoutes(db, undefined, bridge));
        app.use(errorHandler);
        await bridge.start();
        publicUrl = bridge.publicIngressBaseUrl!;
    }, 120000);
    afterAll(async () => { try {
        await stop(server);
        await bridge?.close();
        await db?.$client.end({ timeout: 5 });
        await pg?.stop();
    }
    finally {
        if (root)
            fs.rmSync(root, { recursive: true, force: true });
    } }, 30000);
    it("executes all fifteen contracts through Node and Actix ingress", async () => {
        for (const base of [nodeUrl, publicUrl]) {
            const list = await call(base, "get", `/api/orgs/${org}/agents`);
            expect(list.status, list.text).toBe(200);
            expect(list.body).toHaveLength(2);
            expect(list.body[0]).not.toHaveProperty("workspaceKey");
            const baseline = (await agentService(db).list(org)).map(row => ({ ...row, agentRuntimeConfig: omitSecretPayloadFields(redactEventPayload(row.agentRuntimeConfig)), runtimeConfig: omitSecretPayloadFields(redactEventPayload(row.runtimeConfig)) }));
            const byId = (rows: {
                id: string;
            }[]) => JSON.parse(JSON.stringify(rows)).sort((a: {
                id: string;
            }, b: {
                id: string;
            }) => a.id.localeCompare(b.id));
            expect(byId(list.body)).toEqual(byId(baseline));
            const configs = await call(base, "get", `/api/orgs/${org}/agent-configurations`);
            expect(configs.status, configs.text).toBe(200);
            expect(configs.body).toHaveLength(2);
            const name = await call(base, "get", `/api/orgs/${org}/agents/name-suggestion`);
            expect(name.status, name.text).toBe(200);
            expect(typeof name.body.name).toBe("string");
            const configuration = await call(base, "get", `/api/agents/${agent}/configuration`);
            expect(configuration.status, configuration.text).toBe(200);
            expect(configuration.body.permissions.canCreateAgents).toBe(false);
            const revisions = await call(base, "get", `/api/agents/${agent}/config-revisions`);
            expect(revisions.status, revisions.text).toBe(200);
            expect(revisions.body.some((r: {
                id: string;
            }) => r.id === revision)).toBe(true);
            const detail = await call(base, "get", `/api/agents/${agent}/config-revisions/${revision}`);
            expect(detail.status, detail.text).toBe(200);
            expect(detail.body.beforeConfig.agentRuntimeConfig.nested.password).toBe("***REDACTED***");
            const rollback = await call(base, "post", `/api/agents/${agent}/config-revisions/${revision}/rollback`);
            expect(rollback.status, rollback.text).toBe(200);
            expect(rollback.body.name).toBe("Delta restored");
            const keys = await call(base, "get", `/api/agents/${agent}/keys`);
            expect(keys.status, keys.text).toBe(200);
            expect(JSON.stringify(keys.body)).not.toContain("keyHash");
            expect(byId(keys.body)).toEqual(byId(await agentService(db).listKeys(agent)));
            const key = await call(base, "post", `/api/agents/${agent}/keys`, ownerToken, { name: "Synthetic issued key" });
            expect(key.status, key.text).toBe(201);
            expect(key.body.token).toMatch(/^pcp_[a-f0-9]{48}$/);
            expect(await scalar(sql `SELECT count(*) AS value FROM agent_api_keys WHERE id=${key.body.id}::uuid AND key_hash=${hash(key.body.token)}`)).toBe(1);
            const revoke = await call(base, "delete", `/api/agents/${agent}/keys/${key.body.id}`);
            expect(revoke.status, revoke.text).toBe(200);
            await db.execute(sql `INSERT INTO agent_task_sessions(org_id,agent_id,agent_runtime_type,task_key,session_display_id,session_params_json,last_run_id,updated_at) VALUES(${org}::uuid,${agent}::uuid,'process','visible-task','visible-session','{"keep":"yes","password":"synthetic"}',${publicRun}::uuid,now()-interval '1 minute'),(${org}::uuid,${agent}::uuid,'process','private-task','PEER_PRIVATE_SESSION','{"private":"PEER_PRIVATE_VALUE"}',${privateRun}::uuid,now())`);
            const state = await call(base, "get", `/api/agents/${agent}/runtime-state`);
            expect(state.status, state.text).toBe(200);
            expect(state.body.sessionDisplayId).toBe("visible-session");
            expect(state.text).not.toContain("PEER_PRIVATE");
            const sessions = await call(base, "get", `/api/agents/${agent}/task-sessions`);
            expect(sessions.status, sessions.text).toBe(200);
            expect(sessions.body).toHaveLength(1);
            expect(sessions.body[0].sessionParamsJson.password).toBe("***REDACTED***");
            const inbox = await call(base, "get", "/api/agents/me/inbox-lite", agentToken);
            expect(inbox.status, inbox.text).toBe(200);
            expect(inbox.body).toHaveLength(1);
            expect(inbox.body[0].activeRun).toBeNull();
            const reset = await call(base, "post", `/api/agents/${agent}/runtime-state/reset-session`, ownerToken, {});
            expect(reset.status, reset.text).toBe(200);
            expect(reset.body.clearedTaskSessions).toBe(2);
            const scheduler = await call(base, "get", "/api/instance/scheduler-heartbeats");
            expect(scheduler.status, scheduler.text).toBe(200);
            expect(scheduler.body.some((a: {
                id: string;
                intervalSec: number;
            }) => a.id === agent && a.intervalSec === 60)).toBe(true);
        }
    });
    it("owns schema errors, aliases, auth priority and principal/org isolation", async () => {
        for (const base of [nodeUrl, publicUrl]) {
            for (const [endpoint, schema, key] of [["keys", createAgentKeySchema, "name"], ["runtime-state/reset-session", resetAgentSessionSchema, "taskKey"]] as const) {
                for (const input of [{}, { [key]: null }, { [key]: "" }, { [key]: [] }, { [key]: false }, { [key]: 1 }, { [key]: {} }, { [key]: " \uFEFF " }]) {
                    const expected = schema.safeParse(input);
                    const response = await call(base, "post", `/api/agents/${agent}/${endpoint}`, "", input);
                    expect(response.status, response.text).toBe(expected.success ? 403 : 400);
                    if (!expected.success)
                        expect(response.body).toEqual({ error: "Validation error", details: expected.error.issues });
                }
                expect((await call(base, "post", `/api/agents/${agent}/${endpoint}`, "")).status).toBe(400);
            }
            expect((await call(base, "get", `/api/agents/${agent}/configuration`, otherToken)).status).toBe(403);
            expect((await call(base, "get", `/api/agents/${foreignAgent}/configuration`, agentToken)).status).toBe(403);
            expect((await call(base, "get", `/api/agents/${agent}/configuration`, outsiderToken)).status).toBe(403);
            expect((await call(base, "get", `/api/agents/agt_${agent.replaceAll("-", "").slice(0, 8)}/configuration?orgId=${org}`)).status).toBe(200);
            expect((await call(base, "get", `/api/agents/delta-restored/configuration?orgId=${org}`)).status).toBe(200);
            expect((await call(base, "get", "/api/agents/delta-restored/configuration")).status).toBe(422);
            expect((await call(base, "get", "/api/instance/scheduler-heartbeats", otherToken)).status).toBe(403);
            const denied = await request(base).post(`/api/agents/${agent}/config-revisions/${revision}/rollback`).set("authorization", `Bearer ${agentToken}`).set("x-rudder-agent-id", peer);
            expect(denied.status).toBe(403);
            const restricted = await call(base, "get", `/api/orgs/${org}/agents`, agentToken);
            expect(restricted.status).toBe(200);
            expect(restricted.body.every((a: {
                agentRuntimeConfig: object;
                runtimeConfig: object;
            }) => Object.keys(a.agentRuntimeConfig).length === 0 && Object.keys(a.runtimeConfig).length === 0)).toBe(true);
        }
    });
    it("keeps key identity bound to the selected agent and rolls mutation/audit/outbox back together", async () => {
        const created = await call(nodeUrl, "post", `/api/agents/${peer}/keys`, ownerToken, {});
        expect(created.status).toBe(201);
        expect((await call(nodeUrl, "delete", `/api/agents/${agent}/keys/${created.body.id}`)).status).toBe(404);
        expect(await scalar(sql `SELECT count(*) AS value FROM agent_api_keys WHERE id=${created.body.id}::uuid AND revoked_at IS NULL`)).toBe(1);
        const before = await scalar(sql `SELECT count(*) AS value FROM agent_api_keys WHERE agent_id=${agent}::uuid`);
        await db.execute(sql.raw("CREATE FUNCTION synthetic_agent_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='agent.key_created' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_agent_audit_failure BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION synthetic_agent_audit_failure()"));
        try {
            expect((await call(nodeUrl, "post", `/api/agents/${agent}/keys`, ownerToken, {})).status).toBe(500);
            expect(await scalar(sql `SELECT count(*) AS value FROM agent_api_keys WHERE agent_id=${agent}::uuid`)).toBe(before);
        }
        finally {
            await db.execute(sql.raw("DROP TRIGGER synthetic_agent_audit_failure ON activity_log; DROP FUNCTION synthetic_agent_audit_failure()"));
        }
        expect(await scalar(sql `SELECT count(*) AS value FROM organization_mutation_outbox o LEFT JOIN activity_log a ON a.id=o.activity_id WHERE a.id IS NULL`)).toBe(0);
        const publisher = startOrganizationMutationOutboxPublisher(db, { intervalMs: 60000 });
        try {
            await publisher.drain();
            expect(await scalar(sql `SELECT count(*) AS value FROM organization_mutation_outbox WHERE state='pending'`)).toBe(0);
        }
        finally {
            await publisher.close();
        }
    });
    it("protects reset-session responses with the same private Run policy as reads", async () => {
        for (const base of [nodeUrl, publicUrl]) {
            await db.execute(sql `UPDATE agent_runtime_state SET last_run_id=${privateRun}::uuid,last_run_status='running',state_json='{"private":"RESET_PRIVATE_SENTINEL"}',session_id='private-session' WHERE agent_id=${agent}::uuid`);
            const peerResponse = await call(base, "post", `/api/agents/${agent}/runtime-state/reset-session`, ownerToken, { taskKey: "not-present" });
            expect(peerResponse.status, peerResponse.text).toBe(200);
            expect(peerResponse.body.lastRunId).toBeNull();
            expect(peerResponse.text).not.toContain("RESET_PRIVATE_SENTINEL");
            const ownerResponse = await call(base, "post", `/api/agents/${agent}/runtime-state/reset-session`, otherToken, { taskKey: "not-present" });
            expect(ownerResponse.status, ownerResponse.text).toBe(200);
            expect(ownerResponse.body.lastRunId).toBe(privateRun);
            expect(ownerResponse.body.stateJson.private).toBe("RESET_PRIVATE_SENTINEL");
        }
    });
    it("revalidates signed key facts and scopes audit Run links inside Rust", async () => {
        const ownerKey = (await db.execute(sql `SELECT id FROM board_api_keys WHERE key_hash=${hash(ownerToken)}`))[0]!.id as string;
        const direct: RustFoundationActor = { type: "board", userId: owner, source: "board_key", sessionId: `board-key:${ownerKey}`, isInstanceAdmin: true };
        expect((await bridge!.agentCore!(direct, { operation: "scheduler-heartbeats" })).status).toBe(200);
        try {
            await db.execute(sql `UPDATE board_api_keys SET revoked_at=now() WHERE id=${ownerKey}::uuid`);
            expect((await bridge!.agentCore!(direct, { operation: "scheduler-heartbeats" })).status).toBe(401);
            expect((await bridge!.agentCore!(direct, { operation: "list", orgId: org })).status).toBe(401);
            await db.execute(sql `UPDATE board_api_keys SET revoked_at=NULL,expires_at=now()-interval '1 second' WHERE id=${ownerKey}::uuid`);
            expect((await bridge!.agentCore!(direct, { operation: "scheduler-heartbeats" })).status).toBe(401);
        }
        finally {
            await db.execute(sql `UPDATE board_api_keys SET revoked_at=NULL,expires_at=NULL WHERE id=${ownerKey}::uuid`);
        }
        const key = await call(nodeUrl, "post", `/api/agents/${agent}/keys`, ownerToken, { name: "Revocation check" });
        expect(key.status).toBe(201);
        const agentFact: RustFoundationActor = { type: "agent", agentId: agent, orgId: org, source: "agent_key", sessionId: `agent-key:${key.body.id}` };
        expect((await bridge!.agentCore!(agentFact, { operation: "list", orgId: org })).status).toBe(200);
        await call(nodeUrl, "delete", `/api/agents/${agent}/keys/${key.body.id}`);
        expect((await bridge!.agentCore!(agentFact, { operation: "list", orgId: org })).status).toBe(401);
        const foreignRun = randomUUID();
        await db.execute(sql `INSERT INTO heartbeat_runs(id,org_id,agent_id,status) VALUES(${foreignRun}::uuid,${otherOrg}::uuid,${foreignAgent}::uuid,'succeeded')`);
        const linked = await request(nodeUrl).post(`/api/agents/${agent}/keys`).set("authorization", `Bearer ${ownerToken}`).set("x-rudder-run-id", foreignRun).send({ name: "Cross-org Run fact" });
        expect(linked.status, linked.text).toBe(201);
        const audit = (await db.execute(sql `SELECT run_id FROM activity_log WHERE action='agent.key_created' AND details->>'keyId'=${linked.body.id}`))[0]!;
        expect(audit.run_id).toBeNull();
        for(const base of [nodeUrl,publicUrl]){
            for(const [token,run,expected] of [[ownerToken,privateRun,null],[otherToken,privateRun,privateRun],[ownerToken,publicRun,publicRun]] as const){
                const result=await request(base).post(`/api/agents/${agent}/keys`).set("authorization",`Bearer ${token}`).set("x-rudder-run-id",run).send({name:"Run visibility binding"});
                expect(result.status,result.text).toBe(201);
                const entry=(await db.execute(sql`SELECT a.run_id,o.payload->>'runId' AS outbox_run_id FROM activity_log a JOIN organization_mutation_outbox o ON o.activity_id=a.id WHERE a.action='agent.key_created' AND a.details->>'keyId'=${result.body.id}`))[0]!;
                expect(entry.run_id).toBe(expected);expect(entry.outbox_run_id).toBe(expected);
            }
        }
    });
    it("preserves parser, query, opaque JSON and scheduler coercion boundaries", async () => {
        for (const base of [nodeUrl, publicUrl]) {
            const originalName = (await db.execute(sql `SELECT name FROM agents WHERE id=${agent}::uuid`))[0]!.name as string;
            const alias = originalName.toLowerCase().replaceAll(" ", "-");
            expect((await call(base, "get", `/api/agents/${encodeURIComponent("\uFEFF" + alias + "\uFEFF")}/configuration?orgId=${org}`)).status).toBe(200);
            expect((await call(base, "get", `/api/agents/${alias}/configuration?orgId=${org}&orgId=${otherOrg}`)).status).toBe(422);
            expect((await call(base, "get", `/api/agents/${alias}/configuration?orgId[value]=${org}`)).status).toBe(422);
            const parserBaseline=express();parserBaseline.use(express.json({limit:"10mb"}));parserBaseline.post("/keys",validate(createAgentKeySchema),(_req,res)=>res.json({ok:true}));parserBaseline.use(errorHandler);
            for (const value of [null, [], "string", true, 1]) {
                const response = await request(base).post(`/api/agents/${agent}/keys`).set("authorization", `Bearer ${ownerToken}`).set("content-type", "application/json").send(JSON.stringify(value));
                const expected=await request(parserBaseline).post("/keys").set("content-type","application/json").send(JSON.stringify(value));
                expect({status:response.status,body:response.body}).toEqual({status:expected.status,body:expected.body});
            }
            const nested = JSON.parse('{"unknown":' + '['.repeat(600) + '{"$serde_json::private::RawValue":"not parsed"}' + ']'.repeat(600) + '}');
            const response = await call(base, "post", `/api/agents/${agent}/keys`, ownerToken, nested);
            expect(response.status, response.text).toBe(201);
            expect(response.body.name).toBe("default");
            for (const value of ["\uFEFF0b111100\uFEFF", "0o74", "0x20000000000001", "0x2aa8dc666f6f8d84d9215056a88a2352207464bf9252285a", "0x"+"f".repeat(256), "0x"+"f".repeat(257), ...["8","b","c","4"].map((middle,index)=>"0x"+"f".repeat(13)+middle+(index===1?"f":"0").repeat(242)), ".5", "-1", "", "\u008560", true, [], {}]) {
                await db.execute(sql `UPDATE agents SET runtime_config=${JSON.stringify({ heartbeat: { enabled: "ON", intervalSec: value } })}::jsonb WHERE id=${agent}::uuid`);
                const response = await call(base, "get", "/api/instance/scheduler-heartbeats");
                expect(response.status, response.text).toBe(200);
                const expected = typeof value === "string" && Number.isFinite(Number(value.trim())) ? Math.max(0, Number(value.trim())) : 0;
                expect(response.body.find((row: {
                    id: string;
                }) => row.id === agent).intervalSec).toBe(expected);
            }
        }
    });

    it("retains workspace keys, handles malformed revisions and rejects nonactive key issuance", async()=>{
      const workspaceAgent=randomUUID();
      const legacyPath=path.join(resolveOrganizationAgentsDir(org),"legacy-preserved","instructions");
      await db.execute(sql`INSERT INTO agents(id,org_id,name,role,status,agent_runtime_config,workspace_key) VALUES(${workspaceAgent}::uuid,${org}::uuid,'Legacy agent','engineer','idle',${JSON.stringify({instructionsRootPath:legacyPath})}::jsonb,NULL)`);
      const results=await Promise.all([call(nodeUrl,"get",`/api/agents/${workspaceAgent}/configuration`),call(publicUrl,"get",`/api/agents/${workspaceAgent}/configuration`)]);
      expect(results.map(r=>r.status)).toEqual([200,200]);
      expect((await db.execute(sql`SELECT workspace_key FROM agents WHERE id=${workspaceAgent}::uuid`))[0]!.workspace_key).toBe("legacy-preserved");
      await db.execute(sql`UPDATE agents SET workspace_key='' WHERE id=${workspaceAgent}::uuid`);
      expect((await call(nodeUrl,"get",`/api/agents/${workspaceAgent}/configuration`)).status).toBe(200);
      expect((await db.execute(sql`SELECT workspace_key FROM agents WHERE id=${workspaceAgent}::uuid`))[0]!.workspace_key).toBe("");
      for(const status of ["pending_approval","terminated"]){
        await db.execute(sql`UPDATE agents SET status=${status} WHERE id=${workspaceAgent}::uuid`);
        for(const base of [nodeUrl,publicUrl]) expect((await call(base,"post",`/api/agents/${workspaceAgent}/keys`,ownerToken,{})).status).toBe(409);
      }
      for(const invalid of [null,[],{}, {...snapshot,name:""},{...snapshot,budgetMonthlyCents:"1"},{...snapshot,agentRuntimeConfig:{password:"***REDACTED***"}}]){
        const id=randomUUID();await db.execute(sql`INSERT INTO agent_config_revisions(id,org_id,agent_id,before_config,after_config) VALUES(${id}::uuid,${org}::uuid,${agent}::uuid,'[]'::jsonb,${JSON.stringify(invalid)}::jsonb)`);
        const projection=await call(nodeUrl,"get",`/api/agents/${agent}/config-revisions/${id}`);expect(projection.status,projection.text).toBe(200);expect(projection.body.beforeConfig).toEqual({});
        for(const base of [nodeUrl,publicUrl]) expect((await call(base,"post",`/api/agents/${agent}/config-revisions/${id}/rollback`)).status).toBe(422);
      }
      expect((await call(nodeUrl,"post",`/api/agents/${peer}/config-revisions/${revision}/rollback`)).status).toBe(404);
      const fencedAgent=randomUUID();await db.execute(sql`INSERT INTO agents(id,org_id,name,role,status,workspace_key) VALUES(${fencedAgent}::uuid,${org}::uuid,'Concurrent termination','engineer','idle','concurrent-termination')`);
      let pending:Promise<{status:number}>|undefined;
      await db.$client.begin(async transaction=>{
        await transaction`UPDATE agents SET status='terminated' WHERE id=${fencedAgent}::uuid`;
        pending=call(nodeUrl,"post",`/api/agents/${fencedAgent}/keys`,ownerToken,{}).then(value=>value);
        const deadline=Date.now()+3000;
        while(Date.now()<deadline){
          if(await scalar(sql`SELECT count(*) AS value FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM agents WHERE org_id=%'`))return;
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        throw new Error("Native key issuance never reached the locked agent boundary");
      });
      expect((await pending!).status).toBe(409);
      expect(await scalar(sql`SELECT count(*) AS value FROM agent_api_keys WHERE agent_id=${fencedAgent}::uuid`)).toBe(0);
    });

    it("serializes concurrent revisions, keys, revocation and session resets", async () => {
        const concurrencyRevision = randomUUID();
        await db.execute(sql `INSERT INTO agent_config_revisions(id,org_id,agent_id,before_config,after_config,changed_keys) VALUES(${concurrencyRevision}::uuid,${org}::uuid,${agent}::uuid,${JSON.stringify(snapshot)}::jsonb,${JSON.stringify({ ...snapshot, name: "Concurrent restore", agentRuntimeConfig: { plain: "safe" } })}::jsonb,'["name"]')`);
        const before = await scalar(sql `SELECT count(*) AS value FROM agent_config_revisions WHERE agent_id=${agent}::uuid`);
        const responses = await Promise.all(Array.from({ length: 4 }, (_, index) => call(index % 2 ? nodeUrl : publicUrl, "post", `/api/agents/${agent}/config-revisions/${concurrencyRevision}/rollback`)));
        expect(responses.map(r => r.status)).toEqual([200, 200, 200, 200]);
        expect(await scalar(sql `SELECT count(*) AS value FROM agent_config_revisions WHERE agent_id=${agent}::uuid`)).toBe(before + 1);
        const keys = await Promise.all(Array.from({ length: 4 }, (_, index) => call(index % 2 ? nodeUrl : publicUrl, "post", `/api/agents/${agent}/keys`, ownerToken, { name: `Concurrent ${index}` })));
        expect(keys.map(r => r.status)).toEqual([201, 201, 201, 201]);
        expect(new Set(keys.map(r => r.body.token)).size).toBe(4);
        const revoked = await Promise.all(keys.map((key, index) => call(index % 2 ? nodeUrl : publicUrl, "delete", `/api/agents/${agent}/keys/${key.body.id}`)));
        expect(revoked.map(r => r.status)).toEqual([200, 200, 200, 200]);
        const resets = await Promise.all([call(nodeUrl, "post", `/api/agents/${agent}/runtime-state/reset-session`, ownerToken, {}), call(publicUrl, "post", `/api/agents/${agent}/runtime-state/reset-session`, ownerToken, { taskKey: " \uFEFF " })]);
        expect(resets.map(r => r.status)).toEqual([200, 200]);
    });
    it("returns 503 through both ingress paths with no Node fallback, then survives native restart", async () => {
        const count = await scalar(sql `SELECT count(*) AS value FROM agent_api_keys`);
        const unavailable = createRustFoundationBridge({ databaseUrl, binaryPath: path.join(root, "missing-foundation"), mode: "required", actorEnvelopeKey: "synthetic-unavailable-bridge-key-32bytes" });
        const original = bridge!.agentCore;
        bridge!.agentCore = unavailable.agentCore;
        try {
            for (const base of [nodeUrl, publicUrl]) {
                expect((await call(base, "get", `/api/orgs/${org}/agents`)).status).toBe(503);
                expect((await call(base, "post", `/api/agents/${agent}/keys`, ownerToken, {})).status).toBe(503);
            }
            expect(await scalar(sql `SELECT count(*) AS value FROM agent_api_keys`)).toBe(count);
        }
        finally {
            bridge!.agentCore = original;
            await unavailable.close();
        }
        await bridge!.close();
        await bridge!.start();
        publicUrl = bridge!.publicIngressBaseUrl!;
        for (const base of [nodeUrl, publicUrl]) {
            const keys = await call(base, "get", `/api/agents/${agent}/keys`);
            expect(keys.status, keys.text).toBe(200);
            expect(keys.body.filter((key: {
                name: string;
                revokedAt: string | null;
            }) => key.name.startsWith("Concurrent ")).every((key: {
                revokedAt: string | null;
            }) => key.revokedAt !== null)).toBe(true);
            const state = await call(base, "get", `/api/agents/${agent}/runtime-state`);
            expect(state.status, state.text).toBe(200);
            expect(state.body.sessionId).toBeNull();
        }
        const publisher = startOrganizationMutationOutboxPublisher(db, { intervalMs: 60000 });
        try {
            await publisher.drain();
            expect(await scalar(sql `SELECT count(*) AS value FROM organization_mutation_outbox WHERE state='pending'`)).toBe(0);
        }
        finally {
            await publisher.close();
        }
    });
    it("preserves legacy inbox assignee/reviewer deduplication, priority and age ordering in Rust", async () => {
        const inboxAgent = randomUUID(), inboxToken = `synthetic-inbox-${randomUUID()}`;
        await db.execute(sql `INSERT INTO agents(id,org_id,name,role,status,workspace_key) VALUES(${inboxAgent}::uuid,${org}::uuid,'Inbox regression','engineer','idle',${inboxAgent})`);
        await db.execute(sql `INSERT INTO agent_api_keys(org_id,agent_id,name,key_hash) VALUES(${org}::uuid,${inboxAgent}::uuid,'synthetic inbox',${hash(inboxToken)})`);
        const assigned = randomUUID(), reviewed = randomUUID(), both = randomUUID(), older = randomUUID(), newer = randomUUID(), reviewerOnly = randomUUID();
        const fixtures = [
            { id: assigned, title: "Implement fix", status: "in_progress", priority: "medium", time: "11:00", assignee: inboxAgent, reviewer: null },
            { id: reviewed, title: "Review fix", status: "in_review", priority: "high", time: "09:00", assignee: null, reviewer: inboxAgent },
            { id: both, title: "Review blocker", status: "blocked", priority: "low", time: "08:00", assignee: inboxAgent, reviewer: inboxAgent },
            { id: older, title: "Older task", status: "todo", priority: "medium", time: "10:00", assignee: inboxAgent, reviewer: null },
            { id: newer, title: "Newer task", status: "todo", priority: "medium", time: "12:00", assignee: inboxAgent, reviewer: null },
            { id: reviewerOnly, title: "Reviewer decision", status: "blocked", priority: "low", time: "09:00", assignee: null, reviewer: inboxAgent },
        ];
        for (const row of fixtures) {
            await db.execute(sql `INSERT INTO issues(id,org_id,title,status,priority,assignee_agent_id,reviewer_agent_id,updated_at) VALUES(${row.id}::uuid,${org}::uuid,${row.title},${row.status},${row.priority},${row.assignee}::uuid,${row.reviewer}::uuid,${`2026-05-07T${row.time}:00.000Z`}::timestamptz)`);
        }
        const expected = [
            { id: reviewed, relationship: "reviewer", status: "in_review" },
            { id: older, relationship: "assignee", status: "todo" },
            { id: assigned, relationship: "assignee", status: "in_progress" },
            { id: newer, relationship: "assignee", status: "todo" },
            { id: both, relationship: "reviewer", status: "blocked" },
            { id: reviewerOnly, relationship: "reviewer", status: "blocked" },
        ];
        async function assertInbox(rows: typeof expected) {
            for (const base of [nodeUrl, publicUrl]) {
                const response = await call(base, "get", "/api/agents/me/inbox-lite", inboxToken);
                expect(response.status, response.text).toBe(200);
                expect(response.body.map(({ id, relationship, status }: typeof expected[number]) => ({ id, relationship, status }))).toEqual(rows);
                expect(response.body.filter((row: { id: string }) => row.id === both)).toHaveLength(1);
            }
        }
        await assertInbox(expected);
        for (const issueId of [both, reviewerOnly]) {
            await db.execute(sql `INSERT INTO activity_log(org_id,actor_type,actor_id,action,entity_type,entity_id,details,created_at) VALUES(${org}::uuid,'agent',${inboxAgent},'issue.review_decision_recorded','issue',${issueId},'{"decision":"blocked"}','2026-05-07T13:00:00Z')`);
        }
        await assertInbox(expected.filter(row => row.id !== reviewerOnly).map(row => row.id === both ? { ...row, relationship: "assignee" } : row));
        // A different actor's later comment makes the blocked review actionable again.
        for (const issueId of [both, reviewerOnly]) {
            await db.execute(sql `INSERT INTO activity_log(org_id,actor_type,actor_id,action,entity_type,entity_id,details,created_at) VALUES(${org}::uuid,'user',${owner},'issue.comment_added','issue',${issueId},'{}','2026-05-07T14:00:00Z')`);
        }
        await assertInbox(expected);
    });
    it("preserves legacy scheduler system-copilot exclusion in Rust", async () => {
        const visible = randomUUID(), copilot = randomUUID();
        for (const [id, name, metadata, interval] of [[visible, "Scheduler Builder", {}, 300], [copilot, "Rudder Copilot (system)", { systemManaged: "rudder_copilot" }, 0]] as const) {
            await db.execute(sql `INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type,runtime_config,metadata,workspace_key) VALUES(${id}::uuid,${org}::uuid,${name},'engineer','idle','codex_local',${JSON.stringify({ heartbeat: { enabled: true, intervalSec: interval } })}::jsonb,${JSON.stringify(metadata)}::jsonb,${id})`);
        }
        for (const base of [nodeUrl, publicUrl]) {
            const response = await call(base, "get", "/api/instance/scheduler-heartbeats");
            expect(response.status, response.text).toBe(200);
            expect(response.body.filter((row: { id: string }) => [visible, copilot].includes(row.id))).toEqual([
                expect.objectContaining({ id: visible, agentName: "Scheduler Builder", heartbeatEnabled: true, schedulerActive: true, intervalSec: 300 }),
            ]);
        }
    });
    it("preserves legacy explicit configuration denial despite a persisted agents:create grant in Rust", async () => {
        const deniedAgent = randomUUID(), deniedToken = `synthetic-denied-${randomUUID()}`;
        await db.execute(sql `INSERT INTO agents(id,org_id,name,role,status,permissions,workspace_key) VALUES(${deniedAgent}::uuid,${org}::uuid,'Explicitly denied','engineer','idle','{"canCreateAgents":false}',${deniedAgent})`);
        await db.execute(sql `INSERT INTO agent_api_keys(org_id,agent_id,name,key_hash) VALUES(${org}::uuid,${deniedAgent}::uuid,'synthetic denied',${hash(deniedToken)})`);
        await db.execute(sql `INSERT INTO organization_memberships(org_id,principal_type,principal_id,status,membership_role) VALUES(${org}::uuid,'agent',${deniedAgent},'active','member')`);
        await db.execute(sql `INSERT INTO principal_permission_grants(org_id,principal_type,principal_id,permission_key) VALUES(${org}::uuid,'agent',${deniedAgent},'agents:create')`);
        for (const base of [nodeUrl, publicUrl]) {
            const response = await call(base, "get", `/api/orgs/${org}/agent-configurations`, deniedToken);
            expect(response.status, response.text).toBe(403);
            expect(response.body).toEqual({ error: "Missing permission: can create agents" });
        }
        expect(await scalar(sql `SELECT count(*) AS value FROM principal_permission_grants WHERE org_id=${org}::uuid AND principal_id=${deniedAgent} AND permission_key='agents:create'`)).toBe(1);
        await db.execute(sql `UPDATE agents SET permissions='{"canCreateAgents":true}' WHERE id=${deniedAgent}::uuid`);
        for (const base of [nodeUrl, publicUrl]) {
            const response = await call(base, "get", `/api/orgs/${org}/agent-configurations`, deniedToken);
            expect(response.status, response.text).toBe(200);
            expect(response.body.some((row: { id: string }) => row.id === deniedAgent)).toBe(true);
        }
    });
    async function detailSubject(role = "engineer", permissions: Record<string, unknown> = { canCreateAgents: false, canManageSkills: false }) {
        const id = randomUUID(), token = `synthetic-detail-${randomUUID()}`, workspace = `detail-${id}`;
        await db.execute(sql`INSERT INTO agents(id,org_id,name,role,status,permissions,workspace_key) VALUES(${id}::uuid,${org}::uuid,${`Detail ${id}`},${role},'idle',${JSON.stringify(permissions)}::jsonb,${workspace})`);
        await db.execute(sql`INSERT INTO agent_api_keys(org_id,agent_id,name,key_hash) VALUES(${org}::uuid,${id}::uuid,'synthetic detail',${hash(token)})`);
        return { id, token, workspace };
    }
    it("Agent detail preserves complete self, explicit access, integrations and current spend through both public ingresses", async () => {
        const subject = await detailSubject();
        const secret = randomUUID();
        await db.execute(sql`INSERT INTO organization_secrets(id,org_id,name) VALUES(${secret}::uuid,${org}::uuid,${secret})`);
        await db.execute(sql`INSERT INTO agent_integrations(org_id,agent_id,provider,app_credential_secret_id,external_app_id,settings) VALUES(${org}::uuid,${subject.id}::uuid,'feishu',${secret}::uuid,'synthetic-app','{"feishu":{},"opaque":"stripped"}')`);
        await db.execute(sql`INSERT INTO organization_memberships(org_id,principal_type,principal_id,status,membership_role) VALUES(${org}::uuid,'agent',${subject.id},'suspended','member')`);
        await db.execute(sql`INSERT INTO principal_permission_grants(org_id,principal_type,principal_id,permission_key,scope) VALUES(${org}::uuid,'agent',${subject.id},'tasks:assign','{"opaque":"keep"}')`);
        await db.execute(sql`UPDATE agents SET spent_monthly_cents=999,agent_runtime_config='{"opaque":"literal","password":"synthetic-hidden"}' WHERE id=${subject.id}::uuid`);
        for (const base of [nodeUrl, publicUrl]) for (const [url, token] of [[`/api/agents/${subject.id}`, ownerToken], ["/api/agents/me", subject.token]]) {
            const response = await call(base, "get", url!, token!);
            expect(response.status, response.text).toBe(200);
            expect(response.body).toMatchObject({ id: subject.id, spentMonthlyCents: 0, access: { canAssignTasks: true, taskAssignSource: "explicit_grant", membership: { status: "suspended" }, grants: [{ permissionKey: "tasks:assign", scope: { opaque: "keep" } }] }, instructionsLibraryPath: null });
            expect(response.body.agentRuntimeConfig).toEqual({ opaque: "literal" });
            expect(response.body.integrations[0]).toMatchObject({ externalAppId: "synthetic-app", hasCredentialSecret: true, settings: { feishu: { dailySessionRolloverEnabled: true, dailySessionRolloverHours: 24, dailySessionRolloverNotifyFeishu: true } } });
            expect(response.body.integrations[0]).not.toHaveProperty("appCredentialSecretId");
            expect(response.body).not.toHaveProperty("workspaceKey");
            expect(response.body.rudderTools[0].tools).toEqual([...RUDDER_CORE_MCP_TOOL_NAMES]);
        }
    });
    it("Agent detail retains supported, disabled, unsupported and malformed browser settings contracts", async () => {
        const subject = await detailSubject();
        for (const [runtime, browser, available] of [["codex_local", { enabled: true }, true], ["codex_local", { enabled: false }, false], ["process", { enabled: true }, false], ["claude_local", { enabled: false, unknown: 1 }, true]] as const) {
            await db.execute(sql`UPDATE agents SET agent_runtime_type=${runtime} WHERE id=${subject.id}::uuid`);
            await db.execute(sql`INSERT INTO instance_settings(singleton_key,browser) VALUES('default',${JSON.stringify(browser)}::jsonb) ON CONFLICT(singleton_key) DO UPDATE SET browser=excluded.browser`);
            for (const base of [nodeUrl, publicUrl]) {
                const response = await call(base, "get", `/api/agents/${subject.id}`);
                expect(response.status, response.text).toBe(200);
                expect(response.body.rudderTools[0]).toMatchObject({ id: "rudder-tools", kind: "rudder_mcp", status: "available", serverName: "rudder-tools", contract: "agent-v1", authMode: "runtime_managed", toolCount: RUDDER_CORE_MCP_TOOL_NAMES.length });
                expect(response.body.rudderTools[1]).toMatchObject({ id: "rudder-browser", kind: "rudder_browser_mcp", serverName: "rudder-browser", contract: "browser-v1", authMode: "runtime_managed", status: available ? "available" : "disabled", tools: available ? [...RUDDER_BROWSER_MCP_TOOL_NAMES] : [], toolCount: available ? RUDDER_BROWSER_MCP_TOOL_NAMES.length : 0 });
            }
        }
    });
    it("Agent detail keeps restricted existing-key responses independent of corrupt friendly maps", async () => {
        const subject = await detailSubject(), caller = await detailSubject();
        const original = process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
        const friendly = path.join(root, "corrupt-friendly-map"); fs.mkdirSync(friendly); fs.writeFileSync(path.join(friendly, ".rudder-organizations.json"), "invalid JSON");
        process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = friendly;
        try {
            for (const base of [nodeUrl, publicUrl]) {
                const response = await call(base, "get", `/api/agents/${subject.id}`, caller.token);
                expect(response.status, response.text).toBe(200);
                expect(response.body).toMatchObject({ agentRuntimeConfig: {}, runtimeConfig: {}, instructionsLibraryPath: null });
                expect(response.body).not.toHaveProperty("rudderTools"); expect(response.body).not.toHaveProperty("integrations");
                expect(fs.readdirSync(friendly)).toEqual([".rudder-organizations.json"]);
                expect((await call(base, "get", `/api/agents/${subject.id}`)).status).toBe(500);
                for(const config of [null,false,3,"opaque",[]]) {
                    const malformed=await detailSubject();await db.execute(sql`UPDATE agents SET workspace_key=NULL,agent_runtime_config=${JSON.stringify(config)}::jsonb WHERE id=${malformed.id}::uuid`);
                    const restricted=await call(base,"get",`/api/agents/${malformed.id}`,caller.token);expect(restricted.status,restricted.text).toBe(200);
                    expect(await scalar(sql`SELECT count(*) AS value FROM agents WHERE id=${malformed.id}::uuid AND workspace_key IS NOT NULL`)).toBe(1);
                }
                const blank=await detailSubject();await db.execute(sql`UPDATE agents SET workspace_key='   ',agent_runtime_config='{}' WHERE id=${blank.id}::uuid`);
                expect((await call(base,"get",`/api/agents/${blank.id}`,caller.token)).status).toBe(500);
                await db.execute(sql`UPDATE agents SET workspace_key=${blank.workspace} WHERE id=${blank.id}::uuid`);

            }
        } finally { if (original === undefined) delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME; else process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = original; }
    });
    it("Agent detail preserves managed, explicit external, legacy external and recovered historical instruction semantics", async () => {
        const subject = await detailSubject();
        const directory = path.join(resolveOrganizationAgentsDir(org), subject.workspace, "instructions"); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "USER.md"), "Do not replace my instructions");
        const external = path.join(root, "external-instructions"); fs.mkdirSync(external); fs.writeFileSync(path.join(external, "SOUL.md"), "External content");
        for (const [config, expected] of [[{}, `agents/${subject.workspace}/instructions`], [{ instructionsBundleMode: "external", instructionsRootPath: external }, null], [{ instructionsFilePath: path.join(external, "SOUL.md") }, null]] as const) {
            await db.execute(sql`UPDATE agents SET agent_runtime_config=${JSON.stringify(config)}::jsonb WHERE id=${subject.id}::uuid`);
            for (const base of [nodeUrl, publicUrl]) { const response = await call(base, "get", `/api/agents/${subject.id}`); expect(response.status, response.text).toBe(200); expect(response.body.instructionsLibraryPath).toBe(expected); }
        }
        expect(fs.readFileSync(path.join(directory, "USER.md"), "utf8")).toBe("Do not replace my instructions");
    });
    it("Agent detail recovers historical files without a size cap and matches public default template bytes", async () => {
        const subject=await detailSubject();const legacy=path.join(path.dirname(resolveRudderInstanceRoot()),"historical-fixture","organizations",org.replaceAll("-","").slice(0,12),"workspaces","agents",subject.workspace,"instructions");
        fs.mkdirSync(path.join(legacy,"folder"),{recursive:true});const body="synthetic-large-file\n".repeat(70000);fs.writeFileSync(path.join(legacy,"SOUL.md"),body);
        await db.execute(sql`UPDATE agents SET agent_runtime_config=${JSON.stringify({instructionsFilePath:path.join(legacy,"folder")+"/../SOUL.md"})}::jsonb WHERE id=${subject.id}::uuid`);
        for(const base of [nodeUrl,publicUrl]) {const response=await call(base,"get",`/api/agents/${subject.id}`);expect(response.status,response.text).toBe(200);expect(response.body.instructionsLibraryPath).toBe(`agents/${subject.workspace}/instructions`);}
        const directory=path.join(resolveOrganizationAgentsDir(org),subject.workspace,"instructions");expect(fs.readFileSync(path.join(directory,"SOUL.md"),"utf8")).toBe(body);
        for(const name of ["MEMORY.md","TOOLS.md"]) expect(fs.readFileSync(path.join(directory,name),"utf8")).toBe(fs.readFileSync(path.resolve("server/src/onboarding-assets/default",name),"utf8"));
        const opaque="synthetic-large-response".repeat(60000);await db.execute(sql`UPDATE agents SET runtime_config=${JSON.stringify({opaque})}::jsonb WHERE id=${subject.id}::uuid`);
        for(const base of [nodeUrl,publicUrl]) {const response=await call(base,"patch",`/api/agents/${subject.id}/permissions`,ownerToken,{canCreateAgents:false,canAssignTasks:false,ignored:"x".repeat(150000)});expect(response.status,response.text.slice(0,200)).toBe(200);expect(response.body.runtimeConfig.opaque).toBe(opaque);}
    });
    it("Agent detail default bridge survives a real Node helper holding the shared filesystem lock beyond three seconds", async () => {
        const subject=await detailSubject();const workspace=path.dirname(resolveOrganizationAgentsDir(org));
        for(const base of [nodeUrl,publicUrl]) {
            let acquired!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{acquired=resolve}),hold=new Promise<void>(resolve=>{release=resolve});
            const mkdir=fs.promises.mkdir.bind(fs.promises);let stopped=false;
            const spy=vi.spyOn(fs.promises,"mkdir").mockImplementation((async(target:Parameters<typeof mkdir>[0],options:Parameters<typeof mkdir>[1])=>{
                if(!stopped&&String(target)===workspace&&fs.existsSync(path.join(resolveOrganizationWorkspaceHomeDir(),".rudder-organizations.lock"))){stopped=true;acquired();await hold;}
                return mkdir(target,options);
            }) as typeof fs.promises.mkdir);
            const nodeLayout=ensureOrganizationWorkspaceLayout(org);
            try {await ready;const started=Date.now();const pending=call(base,"patch",`/api/agents/${subject.id}/permissions`,ownerToken,{canCreateAgents:false,canAssignTasks:true}).then(response=>response);
                await new Promise(resolve=>setTimeout(resolve,4100));release();await nodeLayout;const response=await pending;
                expect(Date.now()-started).toBeGreaterThan(4000);expect(response.status,response.text).toBe(200);expect(response.body.access.taskAssignSource).toBe("explicit_grant");
            } finally {release();spy.mockRestore();await nodeLayout;}
        }
    },30000);
    it("Agent detail projects falsy and opaque persisted configuration roots exactly for all three routes", async () => {
        const subject = await detailSubject();
        for (const value of [null, false, 0, "", true, 3, "opaque", [0, { literal: "keep" }]]) {
            await db.execute(sql`UPDATE agents SET agent_runtime_config=${JSON.stringify(value)}::jsonb,runtime_config=${JSON.stringify(value)}::jsonb WHERE id=${subject.id}::uuid`);
            const expected = omitSecretPayloadFields(redactEventPayload((value ?? {}) as Record<string, unknown>) ?? {});
            for (const base of [nodeUrl, publicUrl]) for (const [method, url, token, input] of [["get", `/api/agents/${subject.id}`, ownerToken, undefined], ["get", "/api/agents/me", subject.token, undefined], ["patch", `/api/agents/${subject.id}/permissions`, ownerToken, { canCreateAgents: false, canAssignTasks: false }]] as const) {
                const response = await call(base, method, url, token, input);
                expect(response.status, response.text).toBe(200); expect(response.body.agentRuntimeConfig).toEqual(expected); expect(response.body.runtimeConfig).toEqual(expected);
            }
        }
    },30000);
    it("Agent detail permissions preserve creator assignment, optional skills, current CEO authority and private audit references", async () => {
        const subject = await detailSubject(), ceo = await detailSubject("ceo");
        for (const base of [nodeUrl, publicUrl]) {
            let response = await call(base, "patch", `/api/agents/${subject.id}/permissions`, ownerToken, { canCreateAgents: true, canAssignTasks: false });
            expect(response.status, response.text).toBe(200); expect(response.body.permissions).toEqual({ canCreateAgents: true, canManageSkills: false }); expect(response.body.access.taskAssignSource).toBe("agent_creator");
            expect(await scalar(sql`SELECT count(*) AS value FROM principal_permission_grants WHERE principal_id=${subject.id} AND permission_key='tasks:assign' AND granted_by_user_id=${owner}`)).toBe(1);
            response = await call(base, "patch", `/api/agents/${subject.id}/permissions`, ceo.token, { canCreateAgents: false, canAssignTasks: true });
            expect(response.status, response.text).toBe(200); expect(response.body.access.taskAssignSource).toBe("explicit_grant"); expect(response.body.access.grants[0].grantedByUserId).toBeNull();
            expect((await call(base, "patch", `/api/agents/${subject.id}/permissions`, subject.token, { canCreateAgents: false, canAssignTasks: false })).body).toEqual({ error: "Only CEO can manage permissions" });
            response = await call(base, "patch", `/api/agents/${subject.id}/permissions`, otherToken, { canCreateAgents: false, canAssignTasks: false });
            expect(response.status, response.text).toBe(200); expect(response.body.access.canAssignTasks).toBe(false); expect(response.body.access.grants).toEqual([]);
            for (const [token, runId] of [[ownerToken, null], [otherToken, privateRun]]) {
                const result = await request(base).patch(`/api/agents/${subject.id}/permissions`).set("authorization", `Bearer ${token}`).set("x-rudder-run-id", privateRun).send({ canCreateAgents: false, canAssignTasks: false });
                expect(result.status, result.text).toBe(200);
                const rows = await db.execute(sql`SELECT run_id FROM activity_log WHERE entity_id=${subject.id} AND action='agent.permissions_updated' ORDER BY created_at DESC LIMIT 1`);
                expect(rows[0]?.run_id).toBe(runId);
            }
        }
    });
    it("Agent detail permissions roll back Agent, membership, grant, audit and non-null outbox together", async () => {
        const subject = await detailSubject();
        const snapshot = async () => JSON.stringify(await db.execute(sql`SELECT to_jsonb(a) AS agent,(SELECT jsonb_agg(m) FROM organization_memberships m WHERE principal_id=${subject.id}) AS membership,(SELECT jsonb_agg(g) FROM principal_permission_grants g WHERE principal_id=${subject.id}) AS grants,(SELECT count(*) FROM activity_log WHERE entity_id=${subject.id}) AS audit FROM agents a WHERE id=${subject.id}::uuid`));
        const before = await snapshot();
        await db.execute(sql`CREATE FUNCTION agent_detail_reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback'; END $$`);
        await db.execute(sql`CREATE TRIGGER agent_detail_reject_outbox BEFORE INSERT ON organization_mutation_outbox FOR EACH ROW EXECUTE FUNCTION agent_detail_reject_outbox()`);
        try { for (const base of [nodeUrl, publicUrl]) {expect((await call(base, "patch", `/api/agents/${subject.id}/permissions`, ownerToken, { canCreateAgents: true, canAssignTasks: true })).status).toBe(500);expect(await snapshot()).toBe(before);} }
        finally {await db.execute(sql`DROP TRIGGER agent_detail_reject_outbox ON organization_mutation_outbox`);await db.execute(sql`DROP FUNCTION agent_detail_reject_outbox()`);}
        const response = await call(nodeUrl, "patch", `/api/agents/${subject.id}/permissions`, ownerToken, { canCreateAgents: true, canAssignTasks: true });expect(response.status,response.text).toBe(200);
        expect(await scalar(sql`SELECT count(*) AS value FROM organization_mutation_outbox o JOIN activity_log a ON a.id=o.activity_id AND a.org_id=o.org_id WHERE a.entity_id=${subject.id}`)).toBe(1);
    });
    it("Agent detail enforces request and reference boundaries without Node fallback", async () => {
        const subject = await detailSubject();
        const valid = { canCreateAgents: false, canAssignTasks: false };
        for (const base of [nodeUrl, publicUrl]) {
            expect((await call(base, "get", "/api/agents/me", ownerToken)).status).toBe(401);
            expect((await call(base, "get", `/api/agents/${foreignAgent}`, otherToken)).status).toBe(403);
            for (const ref of [subject.id.toUpperCase(), `agt_${subject.id.replaceAll("-", "").slice(0,8)}`, `agt_${subject.id.replaceAll("-", "").slice(0,12)}`, `agt_${subject.id.replaceAll("-", "")}`]) {const response=await call(base,"get",`/api/agents/${ref}?orgId=${org}`);expect(response.status,response.text).toBe(200);expect(response.body.id).toBe(subject.id);}
            expect((await call(base,"get",`/api/agents/agt_${subject.id.replaceAll("-", "").slice(0,8)}`)).status).toBe(422);
            expect((await call(base,"get",`/api/agents/agt_${subject.id.replaceAll("-", "").slice(0,8)}?orgId=${org}&orgId=${org}`)).status).toBe(422);
            for (const input of [{}, { canCreateAgents: null }, { ...valid, canManageSkills: "true" }, { ...valid, authority: { actorId: subject.id } }]) {
                const parsed=updateAgentPermissionsSchema.safeParse(input);const response=await call(base,"patch",`/api/agents/${subject.id}/permissions`,ownerToken,input);
                if(parsed.success) expect(response.status,response.text).toBe(200);else expect(response.body).toEqual({error:"Validation error",details:parsed.error.issues});
            }
        }
        const original=bridge!.agentCore;bridge!.agentCore=async()=>{throw new Error("synthetic native outage")};
        try {for(const base of [nodeUrl,publicUrl])for(const [method,url,token,input] of [["get",`/api/agents/${subject.id}`,ownerToken,undefined],["get","/api/agents/me",subject.token,undefined],["patch",`/api/agents/${subject.id}/permissions`,ownerToken,valid]] as const){expect((await call(base,method,url,token,input)).status).toBe(503);}}
        finally{bridge!.agentCore=original;}
    });
    async function waitFor(check: () => Promise<boolean> | boolean, label: string) {
        const deadline=Date.now()+8000;
        while(!await check()){if(Date.now()>deadline)throw new Error(`Timed out waiting for ${label}`);await new Promise(resolve=>setTimeout(resolve,20));}
    }
    it("Agent detail permissions recheck a revoked administrator while blocked on actual Agent locks", async () => {
        const subject=await detailSubject();const valid={canCreateAgents:true,canAssignTasks:true};
        for(const base of [nodeUrl,publicUrl]) {
            await db.execute(sql`INSERT INTO instance_user_roles(user_id,role) VALUES(${outsider},'instance_admin') ON CONFLICT DO NOTHING`);
            const connection=await db.$client.reserve();await connection.unsafe("BEGIN");await connection`SELECT id FROM agents WHERE org_id=${org}::uuid ORDER BY id FOR UPDATE`;
            const pending=call(base,"patch",`/api/agents/${subject.id}/permissions`,outsiderToken,valid).then(response=>response);
            try {
                await waitFor(async()=>await scalar(sql`SELECT count(*) AS value FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM agents WHERE org_id=%'`)>0,"Rust Agent mutation lock wait");
                await db.execute(sql`DELETE FROM instance_user_roles WHERE user_id=${outsider} AND role='instance_admin'`);
                await connection.unsafe("COMMIT");const response=await pending;expect(response.status,response.text).toBe(403);
                expect(await scalar(sql`SELECT count(*) AS value FROM activity_log WHERE entity_id=${subject.id}`)).toBe(0);
                expect(await scalar(sql`SELECT count(*) AS value FROM principal_permission_grants WHERE principal_id=${subject.id}`)).toBe(0);
            } finally {await connection.unsafe("ROLLBACK").catch(()=>{});connection.release();await db.execute(sql`DELETE FROM instance_user_roles WHERE user_id=${outsider} AND role='instance_admin'`);await pending;}
        }
    },30000);
    it.each(["node", "required"] as const)("Agent detail permissions reject a board key expiring during an actual Agent lock wait (%s)", async (ingress) => {
        const subject = await detailSubject();
        const base = ingress === "node" ? nodeUrl : publicUrl;
        const input = { canCreateAgents: true, canAssignTasks: true };
        const connection = await db.$client.reserve();
        let pending: Promise<{ status: number; text: string; body: unknown }> | undefined;
        const state = async () => ({
            agent: (await db.execute(sql`SELECT permissions FROM agents WHERE id=${subject.id}::uuid`))[0],
            grants: await db.execute(sql`SELECT * FROM principal_permission_grants WHERE principal_id=${subject.id} ORDER BY id`),
            membership: await db.execute(sql`SELECT * FROM organization_memberships WHERE principal_id=${subject.id} ORDER BY id`),
            activity: await db.execute(sql`SELECT * FROM activity_log WHERE entity_id=${subject.id} ORDER BY id`),
            outbox: await db.execute(sql`SELECT o.* FROM organization_mutation_outbox o JOIN activity_log a ON a.id=o.activity_id AND a.org_id=o.org_id WHERE a.entity_id=${subject.id} ORDER BY o.id`),
        });
        try {
            const before = await state();
            await connection.unsafe("BEGIN");
            await connection`SELECT id FROM agents WHERE org_id=${org}::uuid ORDER BY id FOR UPDATE`;
            await db.execute(sql`UPDATE board_api_keys SET expires_at=clock_timestamp()+interval '2 seconds' WHERE key_hash=${hash(ownerToken)}`);
            pending = call(base, "patch", `/api/agents/${subject.id}/permissions`, ownerToken, input).then(response => response);
            await waitFor(async () => await scalar(sql`SELECT count(*) AS value FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM agents WHERE org_id=%'`) > 0, "permissions request blocked before key expiry");
            await waitFor(async () => await scalar(sql`SELECT count(*) AS value FROM board_api_keys WHERE key_hash=${hash(ownerToken)} AND expires_at <= clock_timestamp()`) === 1, "actual wall-clock key expiry");
            await connection.unsafe("COMMIT");
            const response = await pending;
            expect(response.status, response.text).toBe(401);
            expect(response.body).toEqual({ error: "Unauthorized" });
            expect(await state()).toEqual(before);
            await db.execute(sql`UPDATE board_api_keys SET expires_at=clock_timestamp()+interval '60 seconds' WHERE key_hash=${hash(ownerToken)}`);
            const retry = await call(base, "patch", `/api/agents/${subject.id}/permissions`, ownerToken, input);
            expect(retry.status, retry.text).toBe(200);
            expect(await scalar(sql`SELECT count(*) AS value FROM activity_log WHERE entity_id=${subject.id}`)).toBe(1);
            expect(await scalar(sql`SELECT count(*) AS value FROM organization_mutation_outbox o JOIN activity_log a ON a.id=o.activity_id AND a.org_id=o.org_id WHERE a.entity_id=${subject.id}`)).toBe(1);
        } finally {
            await connection.unsafe("ROLLBACK").catch(() => {});
            connection.release();
            await pending;
            await db.execute(sql`UPDATE board_api_keys SET expires_at=NULL WHERE key_hash=${hash(ownerToken)}`);
        }
    }, 30000);
    it("Agent detail permissions recheck current CEO role after an actual transaction lock wait", async () => {
        const subject=await detailSubject(),ceo=await detailSubject("ceo");
        for(const base of [nodeUrl,publicUrl]) {
            await db.execute(sql`UPDATE agents SET role='ceo' WHERE id=${ceo.id}::uuid`);
            const connection=await db.$client.reserve();await connection.unsafe("BEGIN");await connection`SELECT id FROM agents WHERE org_id=${org}::uuid ORDER BY id FOR UPDATE`;
            const pending=call(base,"patch",`/api/agents/${subject.id}/permissions`,ceo.token,{canCreateAgents:true,canAssignTasks:true}).then(response=>response);
            try {await waitFor(async()=>await scalar(sql`SELECT count(*) AS value FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM agents WHERE org_id=%'`)>0,"CEO mutation lock wait");
                await connection`UPDATE agents SET role='engineer' WHERE id=${ceo.id}::uuid`;await connection.unsafe("COMMIT");const response=await pending;expect(response.status,response.text).toBe(403);expect(response.body.error).toBe("Only CEO can manage permissions");
                expect(await scalar(sql`SELECT count(*) AS value FROM activity_log WHERE entity_id=${subject.id}`)).toBe(0);
            } finally {await connection.unsafe("ROLLBACK").catch(()=>{});connection.release();await pending;}
        }
    },30000);
    it("Agent detail native lock timeout rolls back its mutation and allows a fresh retry", async () => {
        const subject=await detailSubject(),workspaceHome=resolveOrganizationWorkspaceHomeDir(),lock=path.join(workspaceHome,".rudder-organizations.lock"),token=randomUUID();
        fs.mkdirSync(lock,{mode:0o700});fs.writeFileSync(path.join(lock,`.rudder-lock-owner-${token}.json`),JSON.stringify({kind:"rudder-organization-workspace-map-lock",version:1,token,pid:process.pid,hostname:os.hostname(),createdAt:new Date().toISOString()}),{flag:"wx",mode:0o600});
        const input={canCreateAgents:true,canAssignTasks:true};
        try {const started=Date.now();const response=await call(nodeUrl,"patch",`/api/agents/${subject.id}/permissions`,ownerToken,input);expect(response.status,response.text).toBe(500);expect(Date.now()-started).toBeGreaterThanOrEqual(9900);
            expect(fs.existsSync(path.join(lock,`.rudder-lock-owner-${token}.json`))).toBe(true);expect(await scalar(sql`SELECT count(*) AS value FROM activity_log WHERE entity_id=${subject.id}`)).toBe(0);expect(await scalar(sql`SELECT count(*) AS value FROM principal_permission_grants WHERE principal_id=${subject.id}`)).toBe(0);
            expect((await db.execute(sql`SELECT permissions FROM agents WHERE id=${subject.id}::uuid`))[0]?.permissions).toEqual({canCreateAgents:false,canManageSkills:false});
        } finally {fs.rmSync(lock,{recursive:true,force:true});}
        const retry=await call(nodeUrl,"patch",`/api/agents/${subject.id}/permissions`,ownerToken,input);expect(retry.status,retry.text).toBe(200);expect(await scalar(sql`SELECT count(*) AS value FROM activity_log WHERE entity_id=${subject.id}`)).toBe(1);
    },20000);
    it.each(["configured", "unset"])("Agent detail file-lock wait rechecks credentials and preserves transaction rollback with %s RUDDER_HOME", async (homeMode) => {
        const originalHome = process.env.RUDDER_HOME;
        const originalWorkspaceHome = process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
        const homeDirectory = vi.spyOn(os, "homedir").mockReturnValue(path.join(root, `synthetic-${homeMode}-user-home`));
        delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
        if (homeMode === "unset") delete process.env.RUDDER_HOME;
        else process.env.RUDDER_HOME = path.join(root, "configured-rudder-home");
        try {
        const subject=await detailSubject();const home=path.dirname(resolveOrganizationAgentsDir(org));
        // Use the same canonical home resolver as the production map lock.
        const workspaceHome=resolveOrganizationWorkspaceHomeDir();
        fs.mkdirSync(workspaceHome,{recursive:true});const lock=path.join(workspaceHome,".rudder-organizations.lock");const token=randomUUID();fs.mkdirSync(lock,{mode:0o700});
        fs.writeFileSync(path.join(lock,`.rudder-lock-owner-${token}.json`),JSON.stringify({kind:"rudder-organization-workspace-map-lock",version:1,token,pid:process.pid,hostname:os.hostname(),createdAt:new Date().toISOString()}),{flag:"wx",mode:0o600});
        const pending=call(nodeUrl,"patch",`/api/agents/${subject.id}/permissions`,otherToken,{canCreateAgents:true,canAssignTasks:true}).then(response=>response);
        try {
            await waitFor(()=>fs.readdirSync(workspaceHome).some(name=>name.startsWith(".rudder-organizations.lock.acquire-")),"native filesystem lock acquisition");
            await db.execute(sql`UPDATE board_api_keys SET revoked_at=now() WHERE key_hash=${hash(otherToken)}`);
            fs.rmSync(lock,{recursive:true});const response=await pending;expect(response.status,response.text).toBe(401);
            expect(await scalar(sql`SELECT count(*) AS value FROM activity_log WHERE entity_id=${subject.id}`)).toBe(0);
            expect(await scalar(sql`SELECT count(*) AS value FROM principal_permission_grants WHERE principal_id=${subject.id}`)).toBe(0);
            expect(fs.existsSync(path.join(home,"agents",subject.workspace))).toBe(false);
        } finally {fs.rmSync(lock,{recursive:true,force:true});await db.execute(sql`UPDATE board_api_keys SET revoked_at=NULL WHERE key_hash=${hash(otherToken)}`);await pending;}
        } finally {
            homeDirectory.mockRestore();
            if (originalHome === undefined) delete process.env.RUDDER_HOME; else process.env.RUDDER_HOME = originalHome;
            if (originalWorkspaceHome === undefined) delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME; else process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = originalWorkspaceHome;
        }
    },20000);
});
