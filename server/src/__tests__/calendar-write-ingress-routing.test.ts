import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { calendarRoutes } from "../routes/calendar.js";
import type { CalendarNativeBridge } from "../services/calendar-native-bridge.js";

const mocks = vi.hoisted(() => ({ calendar: vi.fn(), connectGoogle: vi.fn(), logActivity: vi.fn() }));
vi.mock("../services/calendar.js", () => ({ calendarService: () => ({ connectGoogle: mocks.connectGoogle }) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: mocks.logActivity }));
const writes = [
  { method: "post", path: "/api/orgs/org/calendar/sources", operation: "source.create", body: { name: "Synthetic calendar" } },
  { method: "patch", path: "/api/orgs/org/calendar/sources/source", operation: "source.update", body: { name: "Renamed calendar" } },
  { method: "delete", path: "/api/orgs/org/calendar/sources/source", operation: "source.delete", body: undefined },
  { method: "post", path: "/api/orgs/org/calendar/events", operation: "event.create", body: { title: "Synthetic event" } },
  { method: "patch", path: "/api/orgs/org/calendar/events/event", operation: "event.update", body: { title: "Renamed event" } },
  { method: "delete", path: "/api/orgs/org/calendar/events/event", operation: "event.delete", body: undefined },
] as const;
function app(required: boolean) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "local_implicit", userId: "synthetic-board", runId: "synthetic-run" };
    next();
  });
  const native = { publicIngressEnabled: required, calendar: mocks.calendar } as CalendarNativeBridge;
  app.use("/api", calendarRoutes({} as never, native));
  app.use(errorHandler);
  return app;
}
beforeEach(() => {
  mocks.calendar.mockReset().mockResolvedValue({ status: 200, contentType: "application/json", body: "{\"native\":true}" });
  mocks.connectGoogle.mockReset().mockResolvedValue({ source: { id: "google-source", visibilityDefault: "full" }, status: "connected" });
  mocks.logActivity.mockReset().mockResolvedValue(undefined);
});
describe("Calendar local write authority at required public ingress", () => {
  it.each(writes)("omits $method $path before any Node adapter", async ({ method, path, body }) => {
    const server = app(true);
    for (const input of [body, null]) expect((await request(server)[method](path).send(input)).status).toBe(404);
    expect(mocks.calendar).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });
  it.each(writes)("retains $operation at the private adapter with unchanged body/audit framing", async ({ method, path, body, operation }) => {
    const response = await request(app(false))[method](path).send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ native: true });
    expect(mocks.calendar).toHaveBeenCalledOnce();
    expect(mocks.calendar.mock.calls[0]?.[2]).toMatchObject({ operation, auditRunId: "synthetic-run", ...(body ? { input: body } : {}) });
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });
  it("leaves the separate Google OAuth adapter outside the six-write gate", async () => {
    const response = await request(app(true)).post("/api/orgs/org/calendar/google/connect").send({});
    expect(response.status).toBe(200);
    expect(mocks.connectGoogle).toHaveBeenCalledOnce();
    expect(mocks.calendar).not.toHaveBeenCalled();
  });
});
