import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { resolveActivityActorName, resolveBoardActorLabel } from "@/lib/activity-actors";
import { ActivityRow } from "./ActivityRow";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

describe("resolveActivityActorName", () => {
  it("labels the current board user as You", () => {
    expect(
      resolveActivityActorName(
        { actorType: "user", actorId: "user-1" },
        new Map(),
        "user-1",
      ),
    ).toBe("You");
  });

  it("keeps generic board copy for other board users", () => {
    expect(
      resolveActivityActorName(
        { actorType: "user", actorId: "user-2" },
        new Map(),
        "user-1",
      ),
    ).toBe("Board");
  });

  it("uses You for the current board user in generic actor labels", () => {
    expect(resolveBoardActorLabel("user", "user-1", "user-1")).toBe("You");
  });
});

describe("ActivityRow", () => {
  it("falls back to the activity details title when no entity map entry exists", () => {
    const html = renderToStaticMarkup(
      <ActivityRow
        event={{
          id: "activity-1",
          orgId: "org-1",
          actorType: "user",
          actorId: "user-1",
          action: "goal.created",
          entityType: "goal",
          entityId: "goal-1",
          agentId: null,
          runId: null,
          details: { title: "Launch the new onboarding flow" },
          createdAt: new Date("2026-04-09T10:00:00.000Z"),
        }}
        agentMap={new Map()}
        entityNameMap={new Map()}
        currentBoardUserId="user-1"
      />,
    );

    expect(html).toContain("You");
    expect(html).toContain("created");
    expect(html).toContain("goal");
    expect(html).toContain("Launch the new onboarding flow");
  });
});
