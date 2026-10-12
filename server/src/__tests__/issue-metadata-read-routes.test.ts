import type { Db } from "@rudderhq/db";
import express, { type Request } from "express";
import { createHash } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { requestIssueMetadataRead } from "../services/issue-metadata-read-bridge.js";
import { createRustActorEnvelope, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";
import type { StorageService } from "../storage/types.js";

const { identity } = vi.hoisted(() => ({ identity: vi.fn() }));
vi.mock("../services/issue-metadata-read-bridge.js", async (original) => ({
  ...await original<typeof import("../services/issue-metadata-read-bridge.js")>(), issueMetadataReadIdentity: identity,
}));
const ORG = "10000000-0000-4000-8000-000000000001", OTHER = "10000000-0000-4000-8000-000000000002", ID = "20000000-0000-4000-8000-000000000001";
const BOARD = { type: "board", source: "local_implicit", userId: "synthetic-user" } as const;
const cases = [
  { path: `/issues/${ID}/attachments`, input: { operation: "attachments", issueId: ID } },
  { path: `/issues/${ID}/work-products`, input: { operation: "work-products", issueId: ID } },
  { path: `/orgs/${ORG}/issues/follows`, input: { operation: "follows", boardUserContext: true } },
];
function app(actor: Request["actor"] = BOARD, bridge?: RustFoundationBridge) {
  const result = express(); result.use((req, _res, next) => { req.actor = actor; next(); });
  const db = { execute: vi.fn().mockResolvedValue([{ timezone: "UTC" }]) } as unknown as Db;
  result.use("/api", issueRoutes(db, {} as StorageService, bridge)); result.use(errorHandler); return result;
}
beforeEach(() => { vi.clearAllMocks(); identity.mockResolvedValue({ id: ID, orgId: ORG }); });
afterEach(() => vi.restoreAllMocks());
describe("Issue metadata selected read authority", () => {
  it.each(cases)("forwards complete native bytes for $path and ignores repeated query values", async ({ path, input }) => {
    const body = Buffer.from('{"native":"' + "x".repeat(300000) + '"}');
    const dispatch = vi.fn().mockResolvedValue({ status: 200, contentType: "application/json", body });
    const response = await request(app(BOARD, { issueMetadataRead: dispatch, mode: "off" } as unknown as RustFoundationBridge)).get(`/api${path}?limit=1&limit=2&status=%00`);
    expect(response.status).toBe(200); expect(response.text).toBe(body.toString());
    expect(dispatch).toHaveBeenCalledWith(BOARD, ORG, { ...input, legacyDateTimezone: "UTC" });
  });
  it.each(cases)("fails closed on unavailable bridge for $path", async ({ path }) => {
    for (const bridge of [undefined, { issueMetadataRead: vi.fn().mockRejectedValue(new Error("offline")) } as unknown as RustFoundationBridge])
      expect((await request(app(BOARD, bridge)).get(`/api${path}`)).status).toBe(503);
  });
  it.each(cases)("authorizes organization before dispatch for $path", async ({ path }) => {
    const dispatch = vi.fn();
    for (const actor of [{ type: "none" }, { type: "agent", source: "agent_key", agentId: ID, orgId: OTHER }, { type: "board", source: "session", userId: "user", orgIds: [OTHER] }] as Request["actor"][]) {
      const response = await request(app(actor, { issueMetadataRead: dispatch } as unknown as RustFoundationBridge)).get(`/api${path}`);
      expect(response.status).toBe(actor.type === "none" ? 401 : 403);
    }
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("preserves missing identity before authorization", async () => {
    identity.mockResolvedValue(null); const dispatch = vi.fn();
    for (const suffix of ["attachments", "work-products"])
      expect((await request(app({ type: "none" }, { issueMetadataRead: dispatch } as unknown as RustFoundationBridge)).get(`/api/issues/${ID}/${suffix}`)).status).toBe(404);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("keeps both follows Board errors and ignores caller user/context fields", async () => {
    const dispatch = vi.fn().mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from("[]") });
    for (const [actor, message] of [
      [{ type: "agent", source: "agent_key", agentId: ID, orgId: ORG }, "Board authentication required"],
      [{ type: "board", source: "local_implicit" }, "Board user context required"],
    ] as [Request["actor"], string][]) {
      const response = await request(app(actor, { issueMetadataRead: dispatch } as unknown as RustFoundationBridge)).get(`/api/orgs/${ORG}/issues/follows`);
      expect(response.status).toBe(403); expect(response.body).toEqual({ error: message });
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect((await request(app(BOARD, { issueMetadataRead: dispatch } as unknown as RustFoundationBridge)).get(`/api/orgs/${ORG}/issues/follows?userId=other&boardUserContext=false`)).status).toBe(200);
    expect(dispatch).toHaveBeenCalledWith(BOARD, ORG, { operation: "follows", boardUserContext: true, legacyDateTimezone: "UTC" });
  });
  it.each([404, 422, 500, 503])("preserves native error %s unchanged", async (status) => {
    const body = Buffer.from('{"error":"native"}'), dispatch = vi.fn().mockResolvedValue({ status, contentType: "application/json", body });
    const response = await request(app(BOARD, { issueMetadataRead: dispatch } as unknown as RustFoundationBridge)).get(`/api${cases[0]!.path}`);
    expect(response.status).toBe(status); expect(response.text).toBe(body.toString());
  });
  it("signs exact operation body action org path and request ID", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new globalThis.Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    const input = { operation: "attachments", issueId: ID } as const;
    const result = await requestIssueMetadataRead("http://127.0.0.1:1", "synthetic-signing-key", 1000, BOARD, ORG, input);
    expect(result.body.toString()).toBe("[]"); const [url, init] = fetch.mock.calls[0]!; const headers = init!.headers as Record<string, string>;
    const envelope = JSON.parse(headers["x-rudder-actor-envelope"]!), body = Buffer.from(JSON.stringify(input)), path = `/internal/orgs/${ORG}/issue-metadata-reads`;
    expect(url).toBe(`http://127.0.0.1:1${path}`); expect(Buffer.from(init!.body as Uint8Array)).toEqual(body);
    expect(envelope.bodySha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(envelope).toEqual(createRustActorEnvelope({ actor: BOARD, organizationId: ORG, method: "POST", path, action: "issue_metadata.read", body, secret: "synthetic-signing-key", nowSeconds: envelope.issuedAt + 1, requestId: envelope.requestId, nonce: envelope.nonce }));
    expect(headers["x-rudder-request-id"]).toBe(envelope.requestId);
  });
});
