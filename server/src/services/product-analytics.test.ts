import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { productAnalyticsRunTerminalEventName, recordProductAnalyticsEvent } from "./product-analytics.js";

function createInsertDb(returnedRows: Array<{ id: string }>) {
  const returning = vi.fn().mockResolvedValue(returnedRows);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  return {
    db: { insert: vi.fn(() => ({ values })) } as any,
    values,
    onConflictDoNothing,
    returning,
  };
}

const baseEvent = {
  orgId: "org-1",
  eventName: "human_work_started" as const,
  sourceTransition: "issue.create",
  confidence: "exact" as const,
  actorType: "human" as const,
  actorId: "user-1",
  entityType: "issue",
  entityId: "issue-1",
  dedupeKey: "human_work_started:issue:issue-1",
  properties: { work_surface: "issue", origin: "human" },
};

describe("product analytics local ledger", () => {
  it.each([
    ["failed", "run_failed"],
    ["cancelled", "run_failed"],
    ["timed_out", "run_failed"],
    ["succeeded", "run_succeeded"],
  ] as const)("maps %s terminal runs to %s", (status, eventName) => {
    expect(productAnalyticsRunTerminalEventName(status)).toBe(eventName);
  });

  it("writes an allowlisted event with an organization-scoped dedupe target", async () => {
    const stub = createInsertDb([{ id: "event-1" }]);

    await expect(recordProductAnalyticsEvent(stub.db, baseEvent)).resolves.toEqual({ id: "event-1" });
    expect(stub.onConflictDoNothing).toHaveBeenCalledWith({ target: expect.any(Array) });
    expect(stub.values).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1",
      eventName: "human_work_started",
      dedupeKey: "human_work_started:issue:issue-1",
    }));
  });

  it("rejects content-bearing and unknown properties before touching the database", async () => {
    const stub = createInsertDb([]);

    await expect(recordProductAnalyticsEvent(stub.db, {
      ...baseEvent,
      properties: { prompt: "do not persist this" } as never,
    })).rejects.toBeInstanceOf(HttpError);
    await expect(recordProductAnalyticsEvent(stub.db, {
      ...baseEvent,
      properties: { arbitrary_dimension: "not allowlisted" } as never,
    })).rejects.toBeInstanceOf(HttpError);
    expect(stub.db.insert).not.toHaveBeenCalled();
  });

  it("rejects unsupported schema versions and non-scalar properties", async () => {
    const stub = createInsertDb([]);

    await expect(recordProductAnalyticsEvent(stub.db, {
      ...baseEvent,
      schemaVersion: 2,
    })).rejects.toBeInstanceOf(HttpError);
    await expect(recordProductAnalyticsEvent(stub.db, {
      ...baseEvent,
      properties: { work_surface: { nested: true } } as never,
    })).rejects.toBeInstanceOf(HttpError);
    expect(stub.db.insert).not.toHaveBeenCalled();
  });

  it("treats a conflict as an idempotent no-op", async () => {
    const stub = createInsertDb([]);
    await expect(recordProductAnalyticsEvent(stub.db, baseEvent)).resolves.toBeNull();
  });

  it("allows bounded output classification without allowing output content", async () => {
    const stub = createInsertDb([{ id: "output-event" }]);
    await expect(recordProductAnalyticsEvent(stub.db, {
      ...baseEvent,
      eventName: "output_ready",
      entityType: "run",
      entityId: "run-1",
      dedupeKey: "output_ready:run-1",
      properties: { output_kind: "structured_result" },
    })).resolves.toEqual({ id: "output-event" });
  });

  it("allows the safe organization provenance dimensions", async () => {
    const stub = createInsertDb([{ id: "organization-event" }]);
    await expect(recordProductAnalyticsEvent(stub.db, {
      orgId: "org-1",
      eventName: "organization_created",
      sourceTransition: "organization.create",
      confidence: "exact",
      actorType: "system",
      entityType: "organization",
      entityId: "org-1",
      dedupeKey: "organization_created:org-1",
      properties: {
        creation_path: "manual",
        template_kind: "custom",
        is_first_organization: true,
        is_user_initiated: true,
      },
    })).resolves.toEqual({ id: "organization-event" });
  });
});
