import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateDesktopTelemetryState, updateDesktopTelemetryState } from "./product-analytics-telemetry.js";
import { uploadDesktopProductAnalyticsOnce } from "./product-analytics-uploader.js";

const eventId = "22222222-2222-4222-8222-222222222222";

describe("desktop product analytics uploader", () => {
  it("keeps the installation secret on the local claim request and ACKs a delivered batch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-telemetry-uploader-"));
    const telemetry = await loadOrCreateDesktopTelemetryState(root);
    await updateDesktopTelemetryState(telemetry.statePath, { mode: "anonymous" });
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.endsWith("/outbox/claim")) {
        return new Response(JSON.stringify({ claimToken: "claim-1", events: [{ eventId, eventName: "work_loop_completed" }] }), { status: 200 });
      }
      if (url.includes("events:batch")) return new Response(JSON.stringify({ accepted: 1, duplicate: 0, rejected: [] }), { status: 200 });
      return new Response(JSON.stringify({ state: "delivered", updatedCount: 1 }), { status: 200 });
    };

    const result = await uploadDesktopProductAnalyticsOnce({
      localApiUrl: "http://127.0.0.1:3100",
      orgId: "org-1",
      installationId: telemetry.installationId,
      installationSecret: telemetry.installationSecret,
      deliveryMode: "anonymous",
      statePath: telemetry.statePath,
      collectorUrl: "https://telemetry.example.test",
      collectorAuthorization: "Bearer collector-token",
      fetchImpl,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    });

    expect(result).toMatchObject({ status: "delivered", eventCount: 1 });
    expect(calls[0]?.body).toMatchObject({ installationSecret: telemetry.installationSecret });
    expect(calls[1]?.body).toEqual({ events: [{ eventId, eventName: "work_loop_completed" }] });
    expect(calls[1]?.body).not.toHaveProperty("installationSecret");
    expect(calls[2]?.body).toMatchObject({ installationSecret: telemetry.installationSecret, claimToken: "claim-1", eventIds: [eventId], delivered: true });
    const persisted = JSON.parse(await readFile(telemetry.statePath, "utf8")) as { lastSucceededAt: string | null };
    expect(persisted.lastSucceededAt).toBe("2026-08-03T00:00:00.000Z");
  });

  it("leaves the batch retryable when the collector is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-telemetry-uploader-"));
    const telemetry = await loadOrCreateDesktopTelemetryState(root);
    await updateDesktopTelemetryState(telemetry.statePath, { mode: "anonymous" });
    let calls = 0;
    const result = await uploadDesktopProductAnalyticsOnce({
      localApiUrl: "http://127.0.0.1:3100",
      orgId: "org-1",
      installationId: telemetry.installationId,
      installationSecret: telemetry.installationSecret,
      deliveryMode: "anonymous",
      statePath: telemetry.statePath,
      collectorUrl: "https://telemetry.example.test",
      collectorAuthorization: "Bearer collector-token",
      fetchImpl: async (url, init) => {
        calls += 1;
        if (url.endsWith("/outbox/claim")) return new Response(JSON.stringify({ claimToken: "claim-1", events: [{ eventId }] }), { status: 200 });
        if (url.includes("events:batch")) throw new Error("offline");
        return new Response(JSON.stringify({ state: "retry_wait" }), { status: 200 });
      },
    });

    expect(result).toMatchObject({ status: "retry_wait", errorCode: "http_503" });
    expect(calls).toBe(3);
  });
});
