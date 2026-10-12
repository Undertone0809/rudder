import type { Db } from "@rudderhq/db";
import express, { type Request } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { approvalRoutes } from "../routes/approvals.js";
import { issueRoutes } from "../routes/issues.js";
import { requestApprovalRead } from "../services/approval-read-bridge.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";
import type { StorageService } from "../storage/types.js";
const { identity } = vi.hoisted(() => ({ identity: vi.fn() }));
vi.mock("../services/approval-read-bridge.js", async (original) => ({ ...await original<typeof import("../services/approval-read-bridge.js")>(), approvalReadIdentity: identity }));
const ORG = "10000000-0000-4000-8000-000000000001", OTHER = "10000000-0000-4000-8000-000000000002", ID = "20000000-0000-4000-8000-000000000001";
const BOARD = { type: "board", source: "local_implicit", userId: "operator" } as const;
const cases = [
    { url: `/orgs/${ORG}/approvals`, input: { operation: "list" } },
    { url: `/approvals/${ID}`, input: { operation: "detail", targetId: ID } },
    { url: `/approvals/${ID}/issues`, input: { operation: "issues", targetId: ID } },
    { url: `/issues/${ID}/approvals`, input: { operation: "issue-approvals", targetId: ID } },
    { url: `/orgs/${ORG}/labels`, input: { operation: "labels" } },
];
function app(actor: Request["actor"] = BOARD, bridge?: RustFoundationBridge) {
    const db = { execute: vi.fn().mockResolvedValue([{ timezone: "UTC" }]) } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", approvalRoutes(db, bridge), issueRoutes(db, {} as StorageService, bridge));
    app.use(errorHandler);
    return app;
}
beforeEach(() => { vi.clearAllMocks(); identity.mockResolvedValue({ id: ID, orgId: ORG }); });
describe("Approval read public dispatch", () => {
    it.each(cases)("forwards complete native bytes for $url", async ({ url, input }) => {
        const body = Buffer.from('{"payload":"' + "x".repeat(300000) + '"}');
        const approvalRead = vi.fn().mockResolvedValue({ status: 200, contentType: "application/json", body });
        const result = await request(app(BOARD, { approvalRead } as unknown as RustFoundationBridge)).get(`/api${url}`);
        expect(result.status).toBe(200);
        expect(result.text).toBe(body.toString());
        expect(approvalRead).toHaveBeenCalledWith(BOARD, ORG, { ...input, legacyDateTimezone: "UTC" });
    });
    it.each(cases)("returns503 without fallback for $url", async ({ url }) => {
        for (const bridge of [undefined, { approvalRead: vi.fn().mockRejectedValue(new Error("offline")) } as unknown as RustFoundationBridge]) {
            const result = await request(app(BOARD, bridge)).get(`/api${url}`);
            expect(result.status).toBe(503);
        }
    });
    it.each(cases)("checks current public authorization before dispatch for $url", async ({ url }) => {
        const approvalRead = vi.fn();
        for (const actor of [{ type: "none" }, { type: "agent", source: "agent_key", agentId: "reader", orgId: OTHER }, { type: "board", source: "session", userId: "reader", orgIds: [] }] as Request["actor"][]) {
            const result = await request(app(actor, { approvalRead } as unknown as RustFoundationBridge)).get(`/api${url}`);
            expect(result.status).toBe(actor.type === "none" ? 401 : 403);
        }
        expect(approvalRead).not.toHaveBeenCalled();
    });
    it("retains status coercion without enum validation or trimming", async () => {
        const approvalRead = vi.fn().mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from("[]") });
        const target = app(BOARD, { approvalRead } as unknown as RustFoundationBridge);
        for (const [query, status] of [["status=", undefined], ["status=unknown", "unknown"], ["status=a&status=b", "a,b"], ["status=&status=", ","], ["status=%20a%20", " a "], ["status[]=a", undefined], ["status=%00", "\u0000"]] as const) {
            expect((await request(target).get(`/api/orgs/${ORG}/approvals?${query}`)).status).toBe(200);
            expect(approvalRead).toHaveBeenLastCalledWith(BOARD, ORG, { operation: "list", status, legacyDateTimezone: "UTC" });
        }
    });
    it("preserves target404 before authorization", async () => {
        identity.mockResolvedValue(null);
        const approvalRead = vi.fn();
        for (const url of [`/approvals/${ID}`, `/approvals/${ID}/issues`, `/issues/${ID}/approvals`]) {
            expect((await request(app({ type: "none" }, { approvalRead } as unknown as RustFoundationBridge)).get(`/api${url}`)).status).toBe(404);
        }
        expect(approvalRead).not.toHaveBeenCalled();
    });
    it("signs the dedicated read capability and exact scalar input", async () => {
        const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
        try {
            const input = { operation: "list", status: "pending,approved" } as const;
            await requestApprovalRead("http://127.0.0.1:1", "synthetic-key", 1000, BOARD, ORG, input);
            const [url, options] = fetch.mock.calls[0]!;
            const envelope = JSON.parse((options!.headers as Record<string, string>)["x-rudder-actor-envelope"]!);
            expect(url).toBe(`http://127.0.0.1:1/internal/orgs/${ORG}/approval-reads`);
            expect(envelope.action).toBe("approval.read");
            expect(Buffer.from(options!.body as Uint8Array).toString()).toBe(JSON.stringify(input));
        }
        finally {
            fetch.mockRestore();
        }
    });
});
