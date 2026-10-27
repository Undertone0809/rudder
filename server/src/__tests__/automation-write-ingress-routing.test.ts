import { createAutomationSchema, createAutomationTriggerSchema, rotateAutomationTriggerSecretSchema, updateAutomationSchema, updateAutomationTriggerSchema } from "@rudderhq/shared";
import express from "express";
import { readFileSync } from "node:fs";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { automationRoutes } from "../routes/automations.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

const org = "22222222-2222-4222-8222-222222222222";
const agent = "11111111-1111-4111-8111-111111111111";
const id = "33333333-3333-4333-8333-333333333333";
const trigger = "44444444-4444-4444-8444-444444444444";
const mocks = vi.hoisted(() => Object.fromEntries(["get", "getTrigger", "create", "update", "delete", "createTrigger", "updateTrigger", "deleteTrigger", "rotateTriggerSecret", "runAutomation", "firePublicTrigger", "audit", "canUser"].map((key) => [key, vi.fn()])));
vi.mock("../services/index.js", () => ({ automationService: () => mocks, accessService: () => ({ canUser: mocks.canUser }), logActivity: (...args: unknown[]) => mocks.audit(...args) }));
const writes = [
  { method: "post", path: `/api/orgs/${org}/automations`, body: { title: "Synthetic automation", assigneeAgentId: agent } },
  { method: "patch", path: `/api/automations/${id}`, body: { title: "Updated" } },
  { method: "delete", path: `/api/automations/${id}`, body: undefined },
  { method: "post", path: `/api/automations/${id}/triggers`, body: { kind: "api" } },
  { method: "patch", path: `/api/automation-triggers/${trigger}`, body: { enabled: false } },
  { method: "delete", path: `/api/automation-triggers/${trigger}`, body: undefined },
  { method: "post", path: `/api/automation-triggers/${trigger}/rotate-secret`, body: {} },
] as const;
function app(selected: boolean) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "synthetic-board" }; next(); });
  app.use("/api", automationRoutes({} as never, { publicIngressEnabled: selected } as RustFoundationBridge));
  app.use(errorHandler); return app;
}
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset().mockResolvedValue({ id, orgId: org, assigneeAgentId: agent, status: "active" });
  mocks.getTrigger.mockResolvedValue({ id: trigger, orgId: org, automationId: id, kind: "webhook" });
  mocks.createTrigger.mockResolvedValue({ trigger: { id: trigger, kind: "api" }, secretMaterial: null });
  mocks.canUser.mockResolvedValue(true);
});
describe("Automation management authority at public native ingress", () => {
  it.each(writes)("omits $method $path before Node validation, lookup, effects and audit", async ({ method, path, body }) => {
    for (const value of [body, { forged: true }]) expect((await request(app(true))[method](path).send(value)).status).toBe(404);
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });
  it.each(writes)("retains explicit unselected $method $path behavior", async ({ method, path, body }) => {
    const response = await request(app(false))[method](path).send(body);
    expect(response.status).toBe(method === "delete" ? 204 : path.endsWith("/triggers") || path.endsWith("/automations") ? 201 : 200);
  });
  it("leaves both Node execution entrypoints selected with their existing owner", async () => {
    const server = app(true);
    expect((await request(server).post(`/api/automations/${id}/run`).send({})).status).toBe(202);
    expect((await request(server).post("/api/automation-triggers/public/synthetic/fire").send({ synthetic: true })).status).toBe(202);
    expect(mocks.runAutomation).toHaveBeenCalledOnce(); expect(mocks.firePublicTrigger).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.createTrigger).not.toHaveBeenCalled();
  });
});

const schemas = { create: createAutomationSchema, update: updateAutomationSchema, "trigger-create": createAutomationTriggerSchema, "trigger-update": updateAutomationTriggerSchema, rotate: rotateAutomationTriggerSecretSchema };
const validationCases = JSON.parse(readFileSync(new URL("../../../native/crates/server-foundation/src/public_ingress/automation_writes/validation-cases.json", import.meta.url), "utf8")) as Array<{ operation: keyof typeof schemas; input: unknown; output?: unknown; issues?: unknown[] }>;
describe("Automation public validation oracle shared with Rust", () => {
  it.each(validationCases)("pins $operation body $input", ({ operation, input, output, issues }) => {
    const result = schemas[operation].safeParse(input);
    if (issues) { expect(result.success).toBe(false); if (!result.success) expect(result.error.issues).toEqual(issues); }
    else { expect(result.success).toBe(true); if (result.success) expect(result.data).toEqual(output); }
  });
});
