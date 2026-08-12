import { describe, expect, it, vi } from "vitest";
import { resolveContextEntities } from "./chats.helpers.js";

describe("resolveContextEntities Goal context", () => {
  it("hydrates a Goal context link with operator-facing Goal fields", async () => {
    const where = vi.fn().mockResolvedValue([{
      id: "goal-1",
      title: "Ship Goal v2",
      description: "Keep the work loop inspectable.",
      lifecycle: "active",
      status: "active",
    }]);
    const from = vi.fn().mockReturnValue({ where });
    const db = { select: vi.fn().mockReturnValue({ from }) };
    const createdAt = new Date("2026-08-10T00:00:00.000Z");

    const [link] = await resolveContextEntities(db as never, [{
      id: "context-goal-1",
      orgId: "org-1",
      conversationId: "chat-1",
      entityType: "goal",
      entityId: "goal-1",
      metadata: null,
      createdAt,
      updatedAt: createdAt,
    }] as never);

    expect(link?.entity).toEqual({
      type: "goal",
      id: "goal-1",
      label: "Ship Goal v2",
      subtitle: "active",
      identifier: null,
      status: "active",
      description: "Keep the work loop inspectable.",
      href: "/goals/goal-1",
    });
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
  });
});
