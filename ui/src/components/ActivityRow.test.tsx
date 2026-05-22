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

  it("uses the nickname for the current board user when configured", () => {
    expect(resolveBoardActorLabel("user", "user-1", "user-1", "  Zee  ")).toBe("Zee");
  });

  it("falls back to You when the configured nickname is blank", () => {
    expect(resolveBoardActorLabel("user", "user-1", "user-1", "   ")).toBe("You");
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
        operatorDisplayName="Zee"
      />,
    );

    expect(html).toContain("Zee");
    expect(html).not.toContain("You");
    expect(html).toContain("created");
    expect(html).toContain("goal");
    expect(html).toContain("Launch the new onboarding flow");
  });

  it("renders code commit activity with the short sha and subject", () => {
    const html = renderToStaticMarkup(
      <ActivityRow
        event={{
          id: "activity-commit",
          orgId: "org-1",
          actorType: "agent",
          actorId: "agent-1",
          action: "issue.code_committed",
          entityType: "issue",
          entityId: "issue-1",
          agentId: "agent-1",
          runId: "run-1",
          details: { shortSha: "abc1234", subject: "fix: report code commit" },
          createdAt: new Date("2026-04-09T10:00:00.000Z"),
        }}
        agentMap={new Map([["agent-1", { id: "agent-1", name: "Wesley", role: "engineer", icon: "rocket" } as any]])}
        entityNameMap={new Map([["issue:issue-1", "ZST-117"]])}
        entityTitleMap={new Map([["issue:issue-1", "Add agent-reported commit activity"]])}
      />,
    );

    expect(html).toContain("Wesley");
    expect(html).toContain("committed abc1234: fix: report code commit to");
    expect(html).toContain("ZST-117");
    expect(html).toContain("Add agent-reported commit activity");
  });
});
