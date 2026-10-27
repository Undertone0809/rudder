import { createSecretSchema, rotateSecretSchema, updateSecretSchema } from "@rudderhq/shared";
import express from "express";
import { readFileSync } from "node:fs";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { secretRoutes } from "../routes/secrets.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

const mocks = vi.hoisted(() => ({ getById: vi.fn(), secret: vi.fn() }));
vi.mock("../services/index.js", () => ({ secretService: () => ({ getById: mocks.getById }) }));

const writes = [
  { method: "post", path: "/api/orgs/org/secrets", body: { name: "Synthetic", value: "synthetic-value" } },
  { method: "post", path: "/api/secrets/secret/rotate", body: { value: "synthetic-rotation" } },
  { method: "patch", path: "/api/secrets/secret", body: { name: "Renamed" } },
  { method: "delete", path: "/api/secrets/secret", body: undefined },
] as const;

function app(required: boolean) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "local_implicit", userId: "synthetic-board" };
    next();
  });
  const native = { publicIngressEnabled: required, secret: mocks.secret } as unknown as RustFoundationBridge;
  app.use("/api", secretRoutes({} as never, native));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  mocks.getById.mockReset().mockResolvedValue({ id: "secret", orgId: "org" });
  mocks.secret.mockReset().mockResolvedValue({ status: 200, contentType: "application/json", body: "{\"native\":true}" });
});

describe("Secret write authority at required public ingress", () => {
  it.each(writes)("omits $method $path before Node lookup, validation or dispatch", async ({ method, path, body }) => {
    const server = app(true);
    for (const payload of [body, { forged: "invalid" }]) {
      const response = await request(server)[method](path).send(payload);
      expect(response.status).toBe(404);
    }
    expect(mocks.getById).not.toHaveBeenCalled();
    expect(mocks.secret).not.toHaveBeenCalled();
  });
  it.each(writes)("keeps the explicit private-listener $method $path adapter", async ({ method, path, body }) => {
    const response = await request(app(false))[method](path).send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ native: true });
    expect(mocks.secret).toHaveBeenCalledOnce();
    expect(mocks.getById).toHaveBeenCalledTimes(path.includes("/orgs/") ? 0 : 1);
  });
});

const validationCases = JSON.parse(readFileSync(new URL("../../../native/crates/server-foundation/src/public_ingress/secret_writes/validation-cases.json", import.meta.url), "utf8")) as Array<{ operation: "create" | "rotate" | "update"; rawBody: string; issues: unknown[] }>;
describe("Secret public validation oracle shared with Rust", () => {
  it.each(validationCases)("pins $operation Zod details for $rawBody", ({ operation, rawBody, issues }) => {
    const schema = { create: createSecretSchema, rotate: rotateSecretSchema, update: updateSecretSchema }[operation];
    const result = schema.safeParse(JSON.parse(rawBody));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(issues);
  });
});
