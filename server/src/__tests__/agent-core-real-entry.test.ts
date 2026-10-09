/** Synthetic PostgreSQL and the source-built foundation, through production routers/auth. */
import { applyPendingMigrations, createDb, ensurePostgresDatabase } from "@rudderhq/db";
import { createAgentKeySchema, resetAgentSessionSchema } from "@rudderhq/shared";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveOrganizationAgentsDir } from "../home-paths.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { validate } from "../middleware/validate.js";
import { omitSecretPayloadFields, redactEventPayload } from "../redaction.js";
import { agentRoutes } from "../routes/agents.js";
import { agentService } from "../services/agents.js";
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
    function call(base: string, method: "get" | "post" | "delete", url: string, token = ownerToken, input?: unknown) { let r = request(base)[method](url); if (token)
        r = r.set("authorization", `Bearer ${token}`); if (input !== undefined)
        r = r.send(input); return r; }
    async function scalar(query: ReturnType<typeof sql>) { const rows = await db.execute(query); return Number(rows[0]?.value ?? 0); }
    beforeAll(async () => {
        const repo = fileURLToPath(new URL("../../../", import.meta.url));
        binary = path.resolve(process.env.RUDDER_SERVER_FOUNDATION_PATH ?? path.join(process.env.CARGO_TARGET_DIR ?? path.join(repo, "native/target"), "debug/rudder-server-foundation"));
        fs.accessSync(binary, fs.constants.X_OK);
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
        bridge = createRustFoundationBridge({ databaseUrl, binaryPath: binary, mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off", requestTimeoutMs: 10000, actorEnvelopeKey: "synthetic-agent-foundation-key-32-bytes", publicIngress: { listenAddr: `127.0.0.1:${await port()}`, nodeUpstream: nodeUrl, authorizationKey: "synthetic-public-ingress-key-32-bytes" } });
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
});
