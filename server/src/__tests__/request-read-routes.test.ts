import type { Db } from "@rudderhq/db";
import express, { type Request } from "express";
import { createHash } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { requestRoutes } from "../routes/requests.js";
import { requestRequestRead } from "../services/request-read-bridge.js";
import { createRustActorEnvelope, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";

const { svc } = vi.hoisted(() => ({ svc: { readIdentity: vi.fn(), getById: vi.fn(), list: vi.fn(), attemptsForRequest: vi.fn(), resolveAssistance: vi.fn(), cancelAssistance: vi.fn() } }));
vi.mock("../services/index.js", () => ({ requestService: () => svc, heartbeatService: () => ({}) }));
const ORG = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const ID = "20000000-0000-4000-8000-000000000001";
const BOARD = { type: "board", source: "local_implicit", userId: "operator" } as const;
const cases = [
  { path: `/orgs/${ORG}/requests?status=open&kind=approval`, input: { operation: "list", status: "open", kind: "approval" } },
  { path: `/requests/${ID}`, input: { operation: "detail", requestId: ID } },
  { path: `/requests/${ID}/block-audit-attempts`, input: { operation: "block-audit-attempts", requestId: ID } },
];
function app(actor: Request["actor"] = BOARD, bridge?: RustFoundationBridge) {
  const result = express();
  result.use((req, _res, next) => { req.actor = actor; next(); });
  result.use("/api", requestRoutes({} as Db, bridge));
  result.use(errorHandler);
  return result;
}
beforeEach(() => { vi.clearAllMocks(); svc.readIdentity.mockResolvedValue({ id: ID, orgId: ORG }); svc.list.mockResolvedValue([]); });
afterEach(() => { vi.restoreAllMocks(); });
describe("Request GET authority boundary", () => {
  it.each(cases)("forwards complete native bytes for $path with mutation pilots disabled", async ({ path, input }) => {
    const body = Buffer.from('{"native":"' + "x".repeat(300_000) + '"}');
    const requestRead = vi.fn().mockResolvedValue({ status: 200, contentType: "application/json", body });
    const response = await request(app(BOARD, { requestRead, mode: "off" } as unknown as RustFoundationBridge)).get(`/api${path}`);
    expect(response.status).toBe(200);
    expect(response.text).toBe(body.toString());
    expect(requestRead).toHaveBeenCalledWith(BOARD, ORG, input);
    expect(svc.list).not.toHaveBeenCalled();
    expect(svc.getById).not.toHaveBeenCalled();
    expect(svc.attemptsForRequest).not.toHaveBeenCalled();
  });
  it.each(cases)("fails closed when unavailable for $path", async ({ path }) => {
    for (const bridge of [undefined, { requestRead: vi.fn().mockRejectedValue(new Error("offline")) } as unknown as RustFoundationBridge]) {
      const response = await request(app(BOARD, bridge)).get(`/api${path}`);
      expect(response.status).toBe(503);
      expect(response.body.error).toBe("Rust Request reads are unavailable");
    }
    expect(svc.list).not.toHaveBeenCalled();
    expect(svc.getById).not.toHaveBeenCalled();
    expect(svc.attemptsForRequest).not.toHaveBeenCalled();
  });
  it.each(cases)("preserves organization access before native dispatch for $path", async ({ path }) => {
    const requestRead = vi.fn();
    for (const actor of [
      { type: "none" }, { type: "agent", source: "agent_key", agentId: "agent", orgId: OTHER },
      { type: "board", source: "session", userId: "user", orgIds: [OTHER] },
    ] as Request["actor"][]) {
      const response = await request(app(actor, { requestRead } as unknown as RustFoundationBridge)).get(`/api${path}`);
      expect(response.status).toBe(actor.type === "none" ? 401 : 403);
    }
    expect(requestRead).not.toHaveBeenCalled();
  });
  it("validates list filters after authorization and strips unknown query keys", async () => {
    const requestRead = vi.fn().mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from("[]") });
    const target = app(BOARD, { requestRead } as unknown as RustFoundationBridge);
    for (const query of ["status=bogus", "kind=bogus", "status=", "kind=", "status=open&status=resolved", "kind=approval&kind=assistance"]) {
      const response = await request(target).get(`/api/orgs/${ORG}/requests?${query}`);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Validation error");
    }
    expect(requestRead).not.toHaveBeenCalled();
    expect((await request(target).get(`/api/orgs/${ORG}/requests?status=resolved&kind=approval&ignored=value`)).status).toBe(200);
    expect(requestRead).toHaveBeenCalledWith(BOARD, ORG, { operation: "list", status: "resolved", kind: "approval" });
    expect(svc.list).not.toHaveBeenCalled();
    const unauthorized = await request(app({ type: "none" }, { requestRead } as unknown as RustFoundationBridge)).get(`/api/orgs/${ORG}/requests?status=bogus`);
    expect(unauthorized.status).toBe(401);
  });
  it.each([400, 404, 422, 500, 503])("preserves native error %s", async (status) => {
    const body = Buffer.from('{"error":"native failure"}');
    const requestRead = vi.fn().mockResolvedValue({ status, contentType: "application/json", body });
    const response = await request(app(BOARD, { requestRead } as unknown as RustFoundationBridge)).get(`/api/requests/${ID}`);
    expect(response.status).toBe(status);
    expect(response.text).toBe(body.toString());
  });
  it("returns missing identity before organization authorization", async () => {
    svc.readIdentity.mockResolvedValue(null);
    const requestRead = vi.fn();
    for (const suffix of ["", "/block-audit-attempts"]) {
      const response = await request(app({ type: "none" }, { requestRead } as unknown as RustFoundationBridge)).get(`/api/requests/${ID}${suffix}`);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Request not found" });
    }
    expect(requestRead).not.toHaveBeenCalled();
  });
  it("omits only the selected public Request reads from Node", async () => {
    const requestRead = vi.fn();
    const target = app(BOARD, { requestRead, publicIngressEnabled: true } as unknown as RustFoundationBridge);
    for (const { path } of cases) {
      const response = await request(target).get(`/api${path}`);
      expect(response.status).toBe(404);
      const head = await request(target).head(`/api${path}`);
      expect(head.status).toBe(404);
    }
    expect(requestRead).not.toHaveBeenCalled();
    expect(svc.readIdentity).not.toHaveBeenCalled();
    expect(svc.list).not.toHaveBeenCalled();
  });
  it.each(["resolve", "cancel"])("omits native Request %s writes without any Node service call", async (action) => {
    const target = app(BOARD, { publicIngressEnabled: true } as RustFoundationBridge);
    const response = await request(target).post(`/api/requests/${ID}/${action}`).send({ resolution: "answered", response: "Human input" });
    expect(response.status).toBe(404);
    expect(svc.getById).not.toHaveBeenCalled();
    expect(svc.resolveAssistance).not.toHaveBeenCalled();
    expect(svc.cancelAssistance).not.toHaveBeenCalled();
  });
  it("signs the exact Requests transport body and action without mutation state", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new globalThis.Response('{"native":true}', { status: 200, headers: { "content-type": "application/json" } }));
    const input = { operation: "detail", requestId: ID } as const;
    const result = await requestRequestRead("http://127.0.0.1:1", "synthetic-signing-key", 1000, BOARD, ORG, input);
    expect(result.body.toString()).toBe('{"native":true}');
    const [url, init] = fetch.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    const envelope = JSON.parse(headers["x-rudder-actor-envelope"]!);
    const body = Buffer.from(JSON.stringify(input));
    expect(url).toBe(`http://127.0.0.1:1/internal/orgs/${ORG}/request-reads`);
    expect(Buffer.from(init!.body as Uint8Array)).toEqual(body);
    expect(envelope.action).toBe("request.read");
    expect(envelope.bodySha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(envelope).toEqual(createRustActorEnvelope({ actor: BOARD, organizationId: ORG, method: "POST", path: `/internal/orgs/${ORG}/request-reads`, action: "request.read", body, secret: "synthetic-signing-key", nowSeconds: envelope.issuedAt + 1, requestId: envelope.requestId, nonce: envelope.nonce }));
    expect(headers["x-rudder-request-id"]).toBe(envelope.requestId);
    expect(envelope.idempotencyKey).toBeNull();
  });
});
