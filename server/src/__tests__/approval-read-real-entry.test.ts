import { agentApiKeys, agents, applyPendingMigrations, approvals, authUsers, boardApiKeys, createDb, createLocalPostgresInstance, ensurePostgresDatabase, issueApprovals, issueLabels, issues, labels, organizationIssuePrefixAliases, organizationMemberships, organizations, type LocalPostgresInstance } from "@rudderhq/db";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signNativeSessionAssertion } from "../auth/native-session-assertion.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { redactApprovalPayload } from "../redaction.js";
import { approvalRoutes } from "../routes/approvals.js";
import { assertCompanyAccess } from "../routes/authz.js";
import { issueRoutes } from "../routes/issues.js";
import { requestApprovalRead } from "../services/approval-read-bridge.js";
import { approvalService } from "../services/approvals.js";
import { issueApprovalService } from "../services/issue-approvals.js";
import { issueService } from "../services/issues.js";
import { getAuthorizedOrgScope } from "../routes/authz.js";
import { resolveIssueReference } from "../services/issue-references.js";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";
import type { StorageService } from "../storage/types.js";
import { nativeIdentityIngressFixture } from "./helpers/native-identity-ingress.js";
vi.mock("../services/index.js", async (original) => {
    const services = await original<typeof import("../services/index.js")>();
    const forbidden = () => { throw new Error("Node Approval/association/label business read must not execute"); };
    return { ...services,
        approvalService: (...args: Parameters<typeof approvalService>) => ({ ...services.approvalService(...args), list: forbidden, getById: forbidden }),
        issueApprovalService: (...args: Parameters<typeof issueApprovalService>) => ({ ...services.issueApprovalService(...args), listApprovalsForIssue: forbidden, listIssuesForApproval: forbidden }),
        issueService: (...args: Parameters<typeof issueService>) => ({ ...services.issueService(...args), listLabels: forbidden, getById: forbidden }),
    };
});
// The independently isolated legacy helpers remain an executable projection oracle.
function legacyRoutes(db: ReturnType<typeof createDb>) {
    const router = express.Router(), approvals = approvalService(db), associations = issueApprovalService(db), issues = issueService(db);
    router.get("/orgs/:orgId/approvals", async (req, res) => { const org = req.params.orgId as string; assertCompanyAccess(req, org); res.json((await approvals.list(org, req.query.status as string | undefined)).map(redactApprovalPayload)); });
    router.get("/approvals/:id", async (req, res) => { const row = await approvals.getById(req.params.id as string); if (!row) {
        res.status(404).json({ error: "Approval not found" });
        return;
    } assertCompanyAccess(req, row.orgId); res.json(redactApprovalPayload(row)); });
    router.get("/approvals/:id/issues", async (req, res) => { const row = await approvals.getById(req.params.id as string); if (!row) {
        res.status(404).json({ error: "Approval not found" });
        return;
    } assertCompanyAccess(req, row.orgId); res.json(await associations.listIssuesForApproval(row.id, row.orgId)); });
    router.get("/issues/:id/approvals", async (req, res) => { const rawId = req.params.id as string; let issueId = rawId; if (/^[A-Z][A-Z0-9]*-\d+$/i.test(rawId)) { const match = await issues.getByIdentifier(rawId); if (match) issueId = match.id; } if (/^[a-z]{3}_/i.test(rawId)) issueId = await resolveIssueReference(db, rawId, { orgIds: getAuthorizedOrgScope(req) }); const row = await issues.getById(issueId); if (!row) {
        res.status(404).json({ error: "Issue not found" });
        return;
    } assertCompanyAccess(req, row.orgId); res.json(await associations.listApprovalsForIssue(row.id, row.orgId)); });
    router.get("/orgs/:orgId/labels", async (req, res) => { const org = req.params.orgId as string; assertCompanyAccess(req, org); res.json(await issues.listLabels(org)); });
    return router;
}
async function freePort() { const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening"); const port = (socket.address() as net.AddressInfo).port; await new Promise<void>((resolve) => socket.close(() => resolve())); return port; }
function canonicalUtcTimestamp(timestamp: string): string | null {
    if (timestamp === "infinity" || timestamp === "-infinity" || timestamp.endsWith(" BC")) return null;
    const match = timestamp.match(/^(\d+)-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/);
    if (!match) return null;
    const year = Number(match[1]);
    if (year < 1) return null;
    const yearText = year >= 10_000 ? `+${String(year).padStart(6, "0")}` : String(year).padStart(4, "0");
    const millisecond = (match[7] ?? "").slice(0, 3).padEnd(3, "0");
    const iso = `${yearText}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${millisecond}Z`;
    const value = Date.parse(iso);
    return Number.isFinite(value) && Math.abs(value) <= 8_640_000_000_000_000 ? new Date(value).toISOString() : null;
}
const modes = process.env.RUDDER_APPROVAL_NODE_ORACLE_ONLY === "1" ? ["node"] as const : ["off", "required"] as const;
describe.each(modes)("Approval and association public read isolation (%s)", (mode) => {
    let db: ReturnType<typeof createDb>, pg: LocalPostgresInstance, server: Server, oracleServer: Server, directory: string;
    let bridge: RustFoundationBridge | undefined, target: Server | string;
    const foreignAgent = randomUUID(), foreignToken = `approval-foreign-${randomUUID()}`;
    const userId = randomUUID(), boardToken = `approval-board-${randomUUID()}`;
    const org = randomUUID(), other = randomUUID(), agent = randomUUID(), token = `oracle-${randomUUID()}`;
    const ownIssue = randomUUID(), foreignIssue = randomUUID(), goodIssue = randomUUID();
    const shortRefCollisionA = "a0000000-0000-4000-8000-000000000001", shortRefCollisionB = "a0000000-0000-4000-8000-000000000002";
    const nativeIdentity = nativeIdentityIngressFixture();
    const ownApproval = randomUUID(), foreignApproval = randomUUID(), goodApproval = randomUUID();
    const ownLabel = randomUUID(), foreignLabel = randomUUID(), badLinkLabel = randomUUID();
    const get = (path: string) => request(target).get(`/api${path}`).set("authorization", `Bearer ${token}`);
    beforeAll(async () => {
        directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "rudder-approval-read-oracle-postgres-"));
        const socket = net.createServer();
        socket.listen(0, "127.0.0.1");
        await once(socket, "listening");
        const port = (socket.address() as net.AddressInfo).port;
        await new Promise<void>((resolve) => socket.close(() => resolve()));
        pg = (await createLocalPostgresInstance({ databaseDir: directory, user: "rudder", password: "rudder", port, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => { }, onError: () => { } })).instance;
        await pg.initialise();
        fs.appendFileSync(`${directory}/postgresql.conf`, "\nunix_socket_directories = ''\nlisten_addresses = '127.0.0.1'\nshared_buffers = '16MB'\n");
        await pg.start();
        const url = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
        await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${port}/postgres`, "rudder");
        await applyPendingMigrations(url);
        db = createDb(url);
        await db.execute(sql.raw(`ALTER DATABASE rudder SET timezone TO '${process.env.RUDDER_APPROVAL_ORACLE_TIMEZONE === "Pacific/Honolulu" ? "Pacific/Honolulu" : "UTC"}'`));
        await db.$client.end({ timeout: 5 });
        db = createDb(url);
        await db.insert(organizations).values([{ id: org, name: "Own", issuePrefix: "ORC", urlKey: "oracle-own" }, { id: other, name: "Foreign", issuePrefix: "FOR", urlKey: "oracle-foreign" }]);
        await db.insert(agents).values([{ id: agent, orgId: org, name: "Reader", role: "general", status: "idle" }, { id: foreignAgent, orgId: other, name: "Foreign reader", role: "general", status: "idle" }]);
        await db.insert(agentApiKeys).values([{ agentId: agent, orgId: org, name: "Read", keyHash: createHash("sha256").update(token).digest("hex") }, { agentId: foreignAgent, orgId: other, name: "Foreign", keyHash: createHash("sha256").update(foreignToken).digest("hex") }]);
        await db.insert(issues).values([{ id: ownIssue, orgId: org, title: "Own dirty links", issueNumber: 1, identifier: "ORC-1" }, { id: foreignIssue, orgId: other, title: "Foreign issue", issueNumber: 1, identifier: "FOR-1" }, { id: goodIssue, orgId: org, title: "Own valid link", issueNumber: 3, identifier: "ORC-3" }, { id: shortRefCollisionA, orgId: org, title: "Short ref collision A" }, { id: shortRefCollisionB, orgId: org, title: "Short ref collision B" }]);
        await db.insert(organizationIssuePrefixAliases).values({ orgId: org, prefix: "OLD" });
        await db.insert(approvals).values([{ id: ownApproval, orgId: org, type: "hire_agent", payload: { safe: "a.b.c", password: "hidden" } }, { id: foreignApproval, orgId: other, type: "hire_agent", payload: { password: "foreign hidden" } }, { id: goodApproval, orgId: org, type: "hire_agent", payload: { ok: "visible" } }]);
        await db.insert(issueApprovals).values([
            { orgId: other, issueId: ownIssue, approvalId: ownApproval, createdAt: new Date("2026-01-01") },
            { orgId: org, issueId: ownIssue, approvalId: foreignApproval, createdAt: new Date("2026-01-02") },
            { orgId: org, issueId: ownIssue, approvalId: goodApproval, createdAt: new Date("2026-01-03") },
            { orgId: org, issueId: foreignIssue, approvalId: ownApproval, createdAt: new Date("2026-01-04") },
            { orgId: org, issueId: goodIssue, approvalId: ownApproval, createdAt: new Date("2026-01-05") },
        ]);
        await db.insert(labels).values([{ id: ownLabel, orgId: org, name: "C good", color: "blue" }, { id: foreignLabel, orgId: other, name: "A foreign", color: "red" }, { id: badLinkLabel, orgId: org, name: "B dirty link", color: "green" }]);
        await db.insert(issueLabels).values([{ issueId: goodIssue, labelId: ownLabel, orgId: org }, { issueId: goodIssue, labelId: foreignLabel, orgId: org }, { issueId: goodIssue, labelId: badLinkLabel, orgId: other }]);
        await db.insert(authUsers).values({ id: userId, name: "Approval reader", email: "approval-reader@example.test", createdAt: new Date(), updatedAt: new Date() });
        await db.insert(organizationMemberships).values({ orgId: org, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
        await db.insert(boardApiKeys).values({ userId, name: "Approval reader", keyHash: createHash("sha256").update(boardToken).digest("hex") });
        function app(oracle: boolean, selected = bridge) { const app = express(); if (!oracle && mode === "required") app.use(nativeIdentity.middleware()); app.get("/api/health", (_req, res) => res.json({ status: "ok" })); app.use(actorMiddleware(db, { deploymentMode: "authenticated", authRequirement: "required" })); const nativeApprovalReads = mode === "required"; app.use("/api", oracle ? legacyRoutes(db) : [approvalRoutes(db, selected, { nativeApprovalReads }), issueRoutes(db, {} as StorageService, selected, { nativeApprovalReads })]); app.use(errorHandler); return app; }
        oracleServer = app(true).listen(0, "127.0.0.1");
        await once(oracleServer, "listening");
        if (mode === "node") {
            target = oracleServer;
            return;
        }
        const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
        const binaryTarget = path.resolve(repoRoot, process.env.CARGO_TARGET_DIR ?? "native/target");
        const binaryName = process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation";
        const explicit = process.env.RUDDER_SERVER_FOUNDATION_PATH?.trim();
        const candidates = explicit ? [path.resolve(repoRoot, explicit)] : [path.join(binaryTarget, "debug", binaryName), path.join(binaryTarget, "release", binaryName)];
        const binary = candidates.find((file) => { try {
            fs.accessSync(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
            return fs.statSync(file).isFile();
        }
        catch {
            return false;
        } }) ?? candidates[0]!;
        fs.accessSync(binary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        const listenPort = await freePort();
        bridge = createRustFoundationBridge({ databaseUrl: url, binaryPath: binary, mode: "off", projectGoalSetMode: "off", organizationBrandingMode: "off", requestTimeoutMs: 10000, ...(mode === "required" ? { publicIngress: { identityAuth: nativeIdentity.identityAuth, listenAddr: "127.0.0.1:0", nodeUpstream: `http://127.0.0.1:${listenPort}`, authorizationKey: "approval-ingress-synthetic-key-32-bytes" } } : {}) });
        server = app(false).listen(listenPort, "127.0.0.1");
        await once(server, "listening");
        await bridge.start();
        target = server;
        if (mode === "required") {
            await bridge.waitForPublicIngressReady!();
            target = bridge.publicIngressBaseUrl!;
        }
    });
    afterAll(async () => { for (const endpoint of [server, oracleServer]) {
        if (endpoint) {
            endpoint.closeAllConnections();
            await new Promise<void>((resolve) => endpoint.close(() => resolve()));
        }
    } await bridge?.close(); await db?.$client.end({ timeout: 5 }); if (pg)
        await pg.stop(); if (directory)
        fs.rmSync(directory, { recursive: true, force: true }); });
    async function pair(url: string, credential = token) { const expected = await request(oracleServer).get(`/api${url}`).set("authorization", `Bearer ${credential}`); const actual = await request(target).get(`/api${url}`).set("authorization", `Bearer ${credential}`); expect(actual.status).toBe(expected.status); expect(actual.body).toEqual(expected.body); return actual; }
    it("excludes foreign approvals and dirty link rows while retaining valid associations", async () => {
        const result = await pair(`/issues/${ownIssue}/approvals`);
        expect(result.status).toBe(200);
        expect(result.body.map((v: {
            id: string;
        }) => v.id)).toEqual([goodApproval]);
    });
    it("excludes foreign issues and nested labels while retaining valid associations", async () => {
        const result = await pair(`/approvals/${ownApproval}/issues`);
        expect(result.status).toBe(200);
        expect(result.body.map((v: {
            id: string;
        }) => v.id)).toEqual([goodIssue]);
        expect(result.body[0].labelIds).toEqual([ownLabel]);
    });
    it("pins raw repeated and malformed status queries without runtime type assertions", async () => {
        for (const query of ["", "?status=", "?status=pending", "?status=unknown", "?status=pending&status=approved", "?status[]=pending&status[]=approved", "?status[x]=pending", "?status=%00"]) {
            const result = await pair(`/orgs/${org}/approvals${query}`);
            expect(result.status).toBe(query.includes("%00") ? 500 : 200);
            if (["?status=unknown", "?status=pending&status=approved"].includes(query))
                expect(result.body).toEqual([]);
        }
    });
    it("pins list/detail and association payload behavior", async () => {
        await db.update(issueApprovals).set({ orgId: org }).where(eq(issueApprovals.approvalId, ownApproval));
        for (const raw of [
            "null", "0", '""', "1e400", "1e-400", JSON.stringify('{"password":"hidden","safe":9007199254740993}'),
            '{"$serde_json::private::Number":"123","$serde_json::private::RawValue":"unparsed","big":9007199254740993}',
            '{"type":"secret_ref","secretId":"id","password":"hide root"}',
            '{"nested":'.repeat(600) + '{"password":"hide","big":9007199254740993}' + '}'.repeat(600),
            JSON.stringify('{"nested":'.repeat(600) + '{"password":"hide"}' + '}'.repeat(600)), '["a.b.c",{"password":"keep root array"}]', '"literal"', 'false', '{"password":{"type":"secret_ref","secretId":"id","password":"keep"},"plain":{"type":"plain","value":{"password":"hide"},"extra":"drop"},"jwt":"a.b.c","array":["a.b.c"],"__proto__":{"x":1}}'
        ]) {
            await db.execute(sql `UPDATE approvals SET payload=${raw}::jsonb WHERE id=${ownApproval}::uuid`);
            const detail = await pair(`/approvals/${ownApproval}`), associated = await pair(`/issues/${ownIssue}/approvals`);
            await pair(`/orgs/${org}/approvals`);
            const projected = associated.body.find((v: {
                id: string;
            }) => v.id === ownApproval);
            expect(projected.payload).toEqual(detail.body.payload);
        }
    });
    it("pins missing, malformed, unauthorized and moved targets", async () => {
        for (const suffix of ["", "/issues"]) {
            const missing = await get(`/approvals/${randomUUID()}${suffix}`), bad = await get(`/approvals/not-a-uuid${suffix}`), foreign = await get(`/approvals/${foreignApproval}${suffix}`);
            expect([missing.status, bad.status, foreign.status]).toEqual([404, 500, 403]);
        }
        const before = await get(`/approvals/${goodApproval}`);
        expect(before.status).toBe(200);
        await db.update(approvals).set({ orgId: other }).where(eq(approvals.id, goodApproval));
        expect((await get(`/approvals/${goodApproval}`)).status).toBe(403);
        await db.update(approvals).set({ orgId: org }).where(eq(approvals.id, goodApproval));
    });
    it("keeps direct labels org-scoped and name/id sorted", async () => {
        const result = await get(`/orgs/${org}/labels`);
        expect(result.status).toBe(200);
        expect(result.body.map((v: {
            id: string;
        }) => v.id)).toEqual([badLinkLabel, ownLabel]);
    });
    it("pins the scalar database encoding of repeated status values", async () => {
        for (const status of ["pending,approved", "{pending,approved}", '["pending","approved"]', "", ",", " pending "]) {
            await db.insert(approvals).values({ orgId: org, type: "legacy", status, payload: {} });
        }
        for (const query of ["?status=pending&status=approved", "?status=&status=", "?status=%20pending%20"]) {
            const result = await pair(`/orgs/${org}/approvals${query}`);
            expect(result.status).toBe(200);
            expect(result.body.map((v: {
                status: string;
            }) => v.status)).toEqual([query.includes("%20") ? " pending " : query.includes("pending&") ? "pending,approved" : ","]);
        }
        const anonymous = await request(target).get(`/api/orgs/${org}/approvals?status=%00`);
        const foreign = await get(`/orgs/${other}/approvals?status=%00`);
        expect([anonymous.status, foreign.status]).toEqual([401, 403]);
    });
    it("serializes Approval dates as canonical UTC across details, links, issues and labels", async () => {
        for (const timestamp of ["0032-01-01 00:00:00Z", "1887-12-31 14:59:59Z", "1969-12-31 23:59:59.999999Z", "infinity", "275760-09-13 00:00:00.000001Z", "275760-09-13 00:00:00.000999Z", "275760-09-13 00:00:00.001Z"]) {
            await db.execute(sql `UPDATE approvals SET created_at=${timestamp}::timestamptz,updated_at=${timestamp}::timestamptz,decided_at=${timestamp}::timestamptz WHERE id=${ownApproval}::uuid`);
            await db.execute(sql `UPDATE issues SET created_at=${timestamp}::timestamptz,updated_at=${timestamp}::timestamptz,started_at=${timestamp}::timestamptz WHERE id=${goodIssue}::uuid`);
            await db.execute(sql `UPDATE labels SET created_at=${timestamp}::timestamptz,updated_at=${timestamp}::timestamptz WHERE id=${ownLabel}::uuid`);
            await db.execute(sql `UPDATE issue_approvals SET created_at=${timestamp}::timestamptz WHERE approval_id=${ownApproval}::uuid`);
            if (mode === "node") {
                for (const url of [`/approvals/${ownApproval}`, `/approvals/${ownApproval}/issues`, `/issues/${goodIssue}/approvals`, `/orgs/${org}/labels`, `/orgs/${org}/approvals`])
                    await pair(url);
                continue;
            }
            const expected = canonicalUtcTimestamp(timestamp);
            const detail = await request(target).get(`/api/approvals/${ownApproval}`).set("authorization", `Bearer ${token}`);
            expect(detail.status).toBe(200);
            expect(detail.body).toMatchObject({ createdAt: expected, updatedAt: expected, decidedAt: expected });

            const list = await request(target).get(`/api/orgs/${org}/approvals`).set("authorization", `Bearer ${token}`);
            expect(list.status).toBe(200);
            expect(list.body.find((row: { id: string }) => row.id === ownApproval)).toMatchObject({ createdAt: expected, updatedAt: expected, decidedAt: expected });

            const associatedIssues = await request(target).get(`/api/approvals/${ownApproval}/issues`).set("authorization", `Bearer ${token}`);
            expect(associatedIssues.status).toBe(200);
            expect(associatedIssues.body.find((row: { id: string }) => row.id === goodIssue)).toMatchObject({ createdAt: expected, updatedAt: expected, startedAt: expected });

            const associatedApprovals = await request(target).get(`/api/issues/${goodIssue}/approvals`).set("authorization", `Bearer ${token}`);
            expect(associatedApprovals.status).toBe(200);
            expect(associatedApprovals.body.find((row: { id: string }) => row.id === ownApproval)).toMatchObject({
                createdAt: expected,
                updatedAt: expected,
                decidedAt: expected,
                link: { createdAt: expected },
            });

            const labelList = await request(target).get(`/api/orgs/${org}/labels`).set("authorization", `Bearer ${token}`);
            expect(labelList.status).toBe(200);
            expect(labelList.body.find((row: { id: string }) => row.id === ownLabel)).toMatchObject({ createdAt: expected, updatedAt: expected });
        }
    });
    it("rechecks live Board membership on every migrated Approval route", async () => {
        const paths = [`/orgs/${org}/approvals`, `/approvals/${ownApproval}`, `/approvals/${ownApproval}/issues`, `/issues/${ownIssue}/approvals`, `/orgs/${org}/labels`];
        for (const url of paths)
            expect((await pair(url, boardToken)).status).toBe(200);
        await db.update(organizationMemberships).set({ status: "inactive" }).where(and(eq(organizationMemberships.orgId, org), eq(organizationMemberships.principalId, userId)));
        try {
            for (const url of paths)
                expect((await pair(url, boardToken)).status).toBe(403);
        }
        finally {
            await db.update(organizationMemberships).set({ status: "active" }).where(and(eq(organizationMemberships.orgId, org), eq(organizationMemberships.principalId, userId)));
        }
        for (const url of paths) {
            expect((await request(target).get(`/api${url}`)).status).toBe(401);
            expect((await request(target).get(`/api${url}`).set("authorization", `Bearer ${foreignToken}`)).status).toBe(403);
        }
    });
    it.runIf(mode === "off")("rejects association targets moved across the private read-adapter boundary", async () => {
        for (const operation of ["issues", "issue-approvals"] as const) {
            const id = operation === "issues" ? goodApproval : goodIssue;
            const table = operation === "issues" ? approvals : issues;
            const url = operation === "issues" ? `/approvals/${id}/issues` : `/issues/${id}/approvals`;
            const original = bridge!.approvalRead!.bind(bridge);
            const intercepted = vi.spyOn(bridge!, "approvalRead").mockImplementationOnce(async (actor, orgId, input) => {
                expect(orgId).toBe(org);
                expect(input).toMatchObject({ operation, targetId: id });
                await db.update(table).set({ orgId: other }).where(eq(table.id, id));
                return original(actor, orgId, input);
            });
            try {
                const response = await get(url);
                expect(intercepted).toHaveBeenCalledOnce();
                expect(response.status).toBe(404);
                expect(response.body).toEqual({ error: operation === "issues" ? "Approval not found" : "Issue not found" });
            }
            finally {
                intercepted.mockRestore();
            }
            try {
                expect((await get(url)).status).toBe(403);
            }
            finally {
                await db.update(table).set({ orgId: org }).where(eq(table.id, id));
            }
        }
    });
    it("returns complete large lists and nested labels without mutating domain state", async () => {
        await db.update(approvals).set({ payload: { safe: "x".repeat(300000) } }).where(eq(approvals.id, goodApproval));
        for (let index = 0; index < 120; index++) {
            const id = randomUUID();
            await db.insert(labels).values({ id, orgId: org, name: `bulk-${index.toString().padStart(3, "0")}`, color: "blue" });
            await db.insert(issueLabels).values({ issueId: goodIssue, labelId: id, orgId: org });
        }
        const snapshot = async () => { const result: unknown[] = []; for (const name of ["approvals", "issues", "labels", "issue_approvals", "issue_labels", "activity_log"])
            result.push(await db.execute(sql.raw(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text value FROM ${name} t`))); return result; };
        const before = await snapshot();
        expect((await pair(`/orgs/${org}/approvals`)).text.length).toBeGreaterThan(300000);
        expect((await pair(`/approvals/${goodApproval}`)).text.length).toBeGreaterThan(300000);
        expect((await pair(`/issues/${ownIssue}/approvals`)).text.length).toBeGreaterThan(300000);
        const linked = await pair(`/approvals/${ownApproval}/issues`);
        expect(linked.body.find((row: {
            id: string;
        }) => row.id === goodIssue).labels.length).toBe(121);
        await pair(`/orgs/${org}/labels`);
        expect(await snapshot()).toEqual(before);
    });
    it.runIf(mode === "off")("returns503 when the private Rust read adapter is unavailable", async () => {
        const port = await freePort();
        const unavailable = { approvalRead: (actor, orgId, input) => requestApprovalRead(`http://127.0.0.1:${port}`, "synthetic-unavailable-key", 1000, actor, orgId, input) } as RustFoundationBridge;
        const upstreamPort = (server.address() as net.AddressInfo).port;
        for (const selected of [undefined, unavailable]) {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            const app = express();
            if (mode === "required") app.use(nativeIdentity.middleware());
            app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
            app.use(actorMiddleware(db, { deploymentMode: "authenticated", authRequirement: "required" }));
            app.use("/api", approvalRoutes(db, selected), issueRoutes(db, {} as StorageService, selected));
            app.use(errorHandler);
            server = app.listen(upstreamPort, "127.0.0.1");
            await once(server, "listening");
            const outageTarget = server;
            for (const url of [`/orgs/${org}/approvals`, `/approvals/${ownApproval}`, `/approvals/${ownApproval}/issues`, `/issues/${ownIssue}/approvals`, `/orgs/${org}/labels`])
                expect((await request(outageTarget).get(`/api${url}`).set("authorization", `Bearer ${token}`)).status).toBe(503);
        }
    });
    it.runIf(mode === "required")("serves all five reads on Rust and omits their Node handlers", async () => {
        const forwarded = vi.spyOn(bridge!, "approvalRead");
        const paths = [
            `/orgs/${org}/approvals`,
            `/approvals/${ownApproval}`,
            `/approvals/${ownApproval}/issues`,
            `/issues/${ownIssue}/approvals`,
            `/orgs/${org}/labels`,
        ];
        for (const url of paths) {
            const response = await pair(url);
            expect(response.status).toBe(200);
        }
        expect(forwarded).not.toHaveBeenCalled();
        for (const url of paths) {
            const path = `/api${url}`;
            const proof = signNativeSessionAssertion({
                key: nativeIdentity.identityAuth.assertionKey,
                method: "GET",
                target: path,
                identity: { kind: "agent_key", agent_id: agent, key_id: randomUUID(), org_id: org, session_id: "approval-read-gate" },
            });
            expect((await request(server).get(path).set("x-rudder-native-session-proof", proof)).status).toBe(404);
        }
        expect(forwarded).not.toHaveBeenCalled();
        forwarded.mockRestore();
    });
    it.runIf(mode === "required")("preserves UUID, issue identifier and typed short-reference paths", async () => {
        const aliases = [
            goodIssue,
            "ORC-3",
            "OLD-3",
            `iss_${goodIssue.replace(/-/g, "").slice(0, 8)}`,
        ];
        for (const reference of aliases) {
            const response = await pair(`/issues/${reference}/approvals`);
            expect(response.status).toBe(200);
            expect(response.body.map((row: { id: string }) => row.id)).toContain(ownApproval);
        }
        expect((await pair(`/issues/iss_${goodIssue.replace(/-/g, "").slice(0, 8)}/approvals`, boardToken)).status).toBe(200);
        expect((await pair(`/issues/iss_${foreignIssue.replace(/-/g, "").slice(0, 8)}/approvals`, boardToken)).status).toBe(404);
        const ambiguous = await pair("/issues/iss_a0000000/approvals");
        expect(ambiguous.status).toBe(409);
        expect(ambiguous.body.details).toEqual({ reference: "iss_a0000000" });
        expect((await get("/issues/FOR-1/approvals")).status).toBe(403);
        expect((await get(`/issues/iss_${foreignIssue.replace(/-/g, "").slice(0, 8)}/approvals`)).status).toBe(404);
        expect((await get(`/issues/agt_${goodIssue.replace(/-/g, "").slice(0, 8)}/approvals`)).status).toBe(422);
    });
    it.runIf(mode === "required")("returns a public Rust database failure without invoking the Node read bridge", async () => {
        const forwarded = vi.spyOn(bridge!, "approvalRead");
        await db.execute(sql.raw("ALTER TABLE labels RENAME TO labels_unavailable"));
        try {
            const response = await request(target)
                .get(`/api/orgs/${org}/labels`)
                .set("authorization", `Bearer ${token}`);
            expect(response.status).toBe(500);
            expect(forwarded).not.toHaveBeenCalled();
        }
        finally {
            await db.execute(sql.raw("ALTER TABLE labels_unavailable RENAME TO labels"));
            forwarded.mockRestore();
        }
    });
});
