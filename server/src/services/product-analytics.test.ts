import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import {
  buildProductAnalyticsExportPayload,
  productAnalyticsRunTerminalEventName,
  pseudonymizeProductAnalyticsId,
  recordProductAnalyticsChatCreated,
  recordProductAnalyticsEvent,
} from "./product-analytics.js";

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
    expect(stub.onConflictDoNothing).toHaveBeenCalledWith({ target: expect.anything() });
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

  it("allows content-free issue and chat creation dimensions", async () => {
    const issueStub = createInsertDb([{ id: "issue-created-event" }]);
    await expect(recordProductAnalyticsEvent(issueStub.db, {
      ...baseEvent,
      eventName: "issue_created",
      dedupeKey: "issue_created:issue-1",
      properties: {
        creation_path: "manual",
        has_goal_link: true,
        has_project_link: false,
        is_sub_issue: false,
      },
    })).resolves.toEqual({ id: "issue-created-event" });

    const chatStub = createInsertDb([{ id: "chat-created-event" }]);
    await expect(recordProductAnalyticsEvent(chatStub.db, {
      ...baseEvent,
      eventName: "chat_created",
      entityType: "chat",
      entityId: "chat-1",
      dedupeKey: "chat_created:chat-1",
      properties: { creation_path: "manual", initial_role: "user", plan_mode: true },
    })).resolves.toEqual({ id: "chat-created-event" });
  });

  it("normalizes chat creation provenance through the shared helper", async () => {
    const stub = createInsertDb([{ id: "chat-created-event" }]);

    await expect(recordProductAnalyticsChatCreated(stub.db, {
      orgId: "org-1",
      conversationId: "chat-1",
      createdAt: new Date("2026-08-06T10:00:00Z"),
      createdByUserId: "user-1",
      actorType: "human",
      actorId: "user-1",
      creationPath: "side_chat",
      planMode: false,
      initialRole: "system",
    })).resolves.toEqual({ id: "chat-created-event" });
    expect(stub.values).toHaveBeenCalledWith(expect.objectContaining({
      sourceTransition: "chat.side_chat.create",
      actorType: "human",
      actorId: "user-1",
      origin: "human",
      dedupeKey: "chat_created:chat-1",
      properties: { creation_path: "side_chat", initial_role: "system", plan_mode: false },
    }));
  });

  it("records work-loop events without treating deferred names as unavailable", async () => {
    const stub = createInsertDb([{ id: "loop-event" }]);
    await expect(recordProductAnalyticsEvent(stub.db, {
      ...baseEvent,
      eventName: "work_loop_completed",
      workSurface: "issue",
      workId: "issue-1",
      workCycleId: "issue:issue-1",
      completionRevision: 1,
      dedupeKey: "work_loop_completed:issue:issue-1:1",
      properties: { work_surface: "issue", origin: "human", review_required: false },
    })).resolves.toEqual({ id: "loop-event" });
  });

  it("exports only pseudonymous identifiers and rejects sensitive payloads", () => {
    const first = pseudonymizeProductAnalyticsId("secret", "org-1");
    expect(first).toBe(pseudonymizeProductAnalyticsId("secret", "org-1"));
    expect(first).not.toBe("org-1");
    expect(buildProductAnalyticsExportPayload("secret", {
      id: "event-1",
      eventName: "human_work_started",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      orgId: "org-1",
      properties: { work_surface: "issue" },
    })).toMatchObject({ pseudonymousOrgId: first });
    expect(() => buildProductAnalyticsExportPayload("secret", {
      id: "event-2",
      eventName: "human_work_started",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      properties: { work_surface: "issue", body: "secret" },
    })).toThrow();
  });
});
