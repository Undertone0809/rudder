import express, { Router } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import {
  createPluginWebhookIngressMiddleware,
  MAX_PLUGIN_WEBHOOK_FAILURE_BYTES,
} from "../middleware/plugin-webhook-security.js";
import { registerPluginOperationsRoutes } from "../routes/plugins.operations-routes.js";

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";
const DELIVERY_ID = "22222222-2222-4222-8222-222222222222";

function createWebhookTestApp(input?: {
  maxBodyBytes?: number;
  rateLimitMax?: number;
  workerError?: Error;
}) {
  const insertReturning = vi.fn(async () => [{ id: DELIVERY_ID }]);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const updateWhere = vi.fn(async () => []);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const db = { insert, update } as any;

  const workerCall = input?.workerError
    ? vi.fn().mockRejectedValue(input.workerError)
    : vi.fn().mockResolvedValue(undefined);
  const router = Router();
  registerPluginOperationsRoutes({
    router,
    db,
    registry: {},
    loader: {},
    lifecycle: {},
    bridgeDeps: null,
    jobDeps: null,
    webhookDeps: { workerManager: { call: workerCall } },
    resolvePlugin: vi.fn(async () => ({
      id: PLUGIN_ID,
      pluginKey: "webhook-test",
      version: "1.0.0",
      status: "ready",
      manifestJson: {
        capabilities: ["webhooks.receive"],
        webhooks: [{ endpointKey: "events", displayName: "Events" }],
      },
    })),
    logPluginMutationActivity: vi.fn(),
    mapRpcErrorToBridgeError: vi.fn(),
  });

  const app = express();
  const ingress = createPluginWebhookIngressMiddleware({
    maxBodyBytes: input?.maxBodyBytes ?? 64 * 1024,
    rateLimitMax: input?.rateLimitMax ?? 100,
    sourceRateLimitMax: 400,
    rateLimitWindowMs: 60_000,
    maxRateLimitBuckets: 100,
  });
  app.use(
    "/api/plugins/:pluginId/webhooks/:endpointKey",
    ingress.rateLimit,
    ingress.rawBody,
    ingress.rawBodyError,
    ingress.decodeBody,
  );
  // Mirrors the production parser order. The webhook parser above must consume
  // the stream so this broader application limit never replaces its raw body.
  app.use(express.json({ limit: "10mb" }));
  app.use("/api", router);
  app.use(errorHandler);

  return { app, insertValues, updateSet, workerCall };
}

describe("plugin webhook ingress security", () => {
  it("accepts a normal webhook while persisting only bounded non-sensitive headers", async () => {
    const { app, insertValues, workerCall } = createWebhookTestApp();
    const rawBody = JSON.stringify({ action: "opened", number: 42 });

    const response = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/events`)
      .set("Content-Type", "application/json")
      .set("Authorization", "Bearer should-not-be-stored")
      .set("Cookie", "session=should-not-be-stored")
      .set("X-Hub-Signature-256", "sha256=should-not-be-stored")
      .set("X-GitHub-Delivery", "delivery-123")
      .set("X-GitHub-Event", "x".repeat(1_500))
      .send(rawBody);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deliveryId: DELIVERY_ID, status: "success" });
    expect(insertValues).toHaveBeenCalledTimes(1);
    const inserted = insertValues.mock.calls[0]?.[0] as Record<string, any>;
    expect(inserted.payload).toEqual({ action: "opened", number: 42 });
    expect(inserted.headers).toEqual(expect.objectContaining({
      "content-type": "application/json",
      "x-github-delivery": "delivery-123",
    }));
    expect(inserted.headers).not.toHaveProperty("authorization");
    expect(inserted.headers).not.toHaveProperty("cookie");
    expect(inserted.headers).not.toHaveProperty("x-hub-signature-256");
    expect(inserted.headers).not.toHaveProperty("x-github-event");

    expect(workerCall).toHaveBeenCalledTimes(1);
    expect(workerCall).toHaveBeenCalledWith(
      PLUGIN_ID,
      "handleWebhook",
      expect.objectContaining({
        endpointKey: "events",
        rawBody,
        parsedBody: { action: "opened", number: 42 },
        headers: expect.objectContaining({
          authorization: "Bearer should-not-be-stored",
          "x-hub-signature-256": "sha256=should-not-be-stored",
        }),
      }),
    );
  });

  it("returns 413 before database or worker dispatch when the raw body exceeds the webhook cap", async () => {
    const { app, insertValues, workerCall } = createWebhookTestApp({ maxBodyBytes: 64 });

    const response = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/events`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ payload: "x".repeat(256) }));

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "Webhook payload too large" });
    expect(insertValues).not.toHaveBeenCalled();
    expect(workerCall).not.toHaveBeenCalled();
  });

  it("returns 429 before database or worker dispatch after an endpoint/source exceeds its quota", async () => {
    const { app, insertValues, workerCall } = createWebhookTestApp({ rateLimitMax: 1 });

    const first = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/events`)
      .send({ delivery: 1 });
    const second = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/events`)
      .send({ delivery: 2 });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
    expect(second.body).toEqual({ error: "Webhook rate limit exceeded" });
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(workerCall).toHaveBeenCalledTimes(1);
  });

  it("does not let an untrusted caller rotate X-Forwarded-For to bypass rate limits", async () => {
    const { app, insertValues, workerCall } = createWebhookTestApp({ rateLimitMax: 1 });

    const first = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/events`)
      .set("X-Forwarded-For", "198.51.100.10")
      .send({ delivery: 1 });
    const second = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/events`)
      .set("X-Forwarded-For", "203.0.113.20")
      .send({ delivery: 2 });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(workerCall).toHaveBeenCalledTimes(1);
  });

  it("bounds persisted worker failures and does not reflect handler details", async () => {
    const workerError = new Error(`sensitive-prefix:${"x".repeat(10_000)}`);
    const { app, updateSet } = createWebhookTestApp({ workerError });

    const response = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/events`)
      .send({ delivery: "failure" });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      deliveryId: DELIVERY_ID,
      status: "failed",
      error: "Plugin webhook handler failed",
    });
    const failureUpdate = updateSet.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(failureUpdate.status).toBe("failed");
    expect(Buffer.byteLength(String(failureUpdate.error), "utf8")).toBeLessThanOrEqual(
      MAX_PLUGIN_WEBHOOK_FAILURE_BYTES,
    );
  });
});
