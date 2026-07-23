import { describe, expect, it } from "vitest";
import {
  clampWorkspaceColumnWidth,
  getWorkspaceColumnMaxWidth,
  preserveRememberedSidePanelWidth,
  resolveDefaultSidePanelWidth,
  resolveProportionalSidePanelWidth,
  resolveProportionalWorkspaceColumnWidth,
  resolveDisplayedSidePanelContext,
  resolveSidePanelCollapseWidth,
  resolveSidePanelContextKey,
  resolveSidePanelDragWidth,
  resolveSidePanelRouteContextKey,
  shouldAutoExpandSidePanel,
  shouldUseFramelessWorkspaceMain,
} from "./Layout";

describe("workspace context column sizing", () => {
  it("lets the issues context column expand to one third of the viewport", () => {
    expect(getWorkspaceColumnMaxWidth("issues", 1440)).toBe(480);
    expect(clampWorkspaceColumnWidth("issues", 900, 1440)).toBe(480);
  });

  it("keeps the issues default width unchanged", () => {
    expect(clampWorkspaceColumnWidth("issues", 248, 1440)).toBe(248);
  });

  it("keeps other context columns on their fixed maximums", () => {
    expect(getWorkspaceColumnMaxWidth("chat", 1440)).toBe(420);
    expect(clampWorkspaceColumnWidth("chat", 900, 1440)).toBe(420);
  });

  it("scales the issues context column from the saved viewport ratio", () => {
    const ratio = 360 / 1440;

    expect(resolveProportionalWorkspaceColumnWidth("issues", ratio, 1200)).toBe(300);
    expect(resolveProportionalWorkspaceColumnWidth("issues", ratio, 1440)).toBe(360);
  });

  it("keeps proportional context columns inside min and max limits", () => {
    const ratio = 360 / 1440;

    expect(resolveProportionalWorkspaceColumnWidth("issues", ratio, 800)).toBe(220);
    expect(resolveProportionalWorkspaceColumnWidth("issues", 900 / 1440, 2400)).toBe(800);
  });

  it("scales the side panel from the saved workspace ratio", () => {
    const ratio = 420 / 1204;

    expect(resolveProportionalSidePanelWidth(ratio, 1004)).toBe(350);
    expect(resolveProportionalSidePanelWidth(ratio, 1204)).toBe(420);
  });

  it("defaults the side panel to half of the shared main workspace", () => {
    expect(resolveDefaultSidePanelWidth(1204)).toBe(600);
  });

  it("lets a compact workspace reach the docked 2:1 boundary", () => {
    expect(resolveProportionalSidePanelWidth(1, 653)).toBeCloseTo(649 * (2 / 3), 5);
  });

  it("lets a wide workspace exceed the old fixed panel cap", () => {
    expect(resolveProportionalSidePanelWidth(1, 1440)).toBeCloseTo(1436 * (2 / 3), 5);
  });

  it("only auto-expands strictly beyond the 2:1 boundary after the 4px resizer", () => {
    expect(shouldAutoExpandSidePanel(800, 1204)).toBe(false);
    expect(shouldAutoExpandSidePanel(800.01, 1204)).toBe(true);
  });

  it("restores custom widths proportionally from the measured workspace", () => {
    expect(resolveProportionalSidePanelWidth(900 / 1440, 1320)).toBe(825);
    expect(resolveProportionalSidePanelWidth(900 / 1440, 980)).toBe(613);
  });

  it("preserves remembered pixels until the workspace is measured", () => {
    expect(preserveRememberedSidePanelWidth(238)).toBe(238);
    expect(preserveRememberedSidePanelWidth(900)).toBe(900);
  });

  it("keeps the docked maximum on the same 2:1 boundary in extremely narrow stacks", () => {
    const boundaryWidth = 476 * (2 / 3);

    expect(resolveDefaultSidePanelWidth(480)).toBe(238);
    expect(resolveProportionalSidePanelWidth(1, 480)).toBeCloseTo(boundaryWidth, 5);
    expect(shouldAutoExpandSidePanel(boundaryWidth, 480)).toBe(false);
    expect(shouldAutoExpandSidePanel(boundaryWidth + 0.01, 480)).toBe(true);
  });

  it("keeps the collapse threshold below the effective minimum in narrow stacks", () => {
    expect(resolveSidePanelCollapseWidth(1204)).toBe(292);
    expect(resolveSidePanelCollapseWidth(480)).toBe(190);
    expect(resolveDefaultSidePanelWidth(480)).toBeGreaterThan(resolveSidePanelCollapseWidth(480));
  });

  it("keeps pointer deltas unchanged without visual scaling", () => {
    expect(resolveSidePanelDragWidth(420, -100, 1000, 1000)).toBe(520);
  });

  it("converts visually scaled pointer deltas into layout-width deltas", () => {
    expect(resolveSidePanelDragWidth(420, -73, 730, 1000)).toBe(520);
  });
});

describe("side panel route context", () => {
  it("scopes side panel state to Messenger chats and issues", () => {
    expect(resolveSidePanelContextKey("/messenger/chat/chat-1")).toBe("chat:chat-1");
    expect(resolveSidePanelContextKey("/messenger/issues/RUD-42")).toBe("issue:RUD-42");
    expect(resolveSidePanelContextKey("/chat/chat-2")).toBe("chat:chat-2");
  });

  it("does not create side panel context for Messenger aggregate routes", () => {
    expect(resolveSidePanelContextKey("/messenger")).toBeNull();
    expect(resolveSidePanelContextKey("/messenger/chat")).toBeNull();
    expect(resolveSidePanelContextKey("/messenger/issues")).toBeNull();
    expect(resolveSidePanelContextKey("/messenger/approvals")).toBeNull();
  });

  it("scopes aggregate route context to the viewed organization", () => {
    expect(resolveSidePanelRouteContextKey("/messenger", "org-a")).toBe(
      "organization:org-a:global",
    );
    expect(resolveSidePanelRouteContextKey("/messenger", "org-b")).toBe(
      "organization:org-b:global",
    );
  });

  it("keeps globally unique detail context keys stable across organization route sync", () => {
    expect(resolveSidePanelRouteContextKey("/messenger/chat/chat-1", "org-a")).toBe(
      "chat:chat-1",
    );
    expect(resolveSidePanelRouteContextKey("/messenger/issues/RUD-42", "org-a")).toBe(
      "issue:RUD-42",
    );
  });

  it("keeps malformed route segments from crashing layout context resolution", () => {
    expect(resolveSidePanelContextKey("/messenger/chat/%E0%A4%A")).toBe("chat:%E0%A4%A");
  });

  it("preserves a held chat context only on Messenger workbench routes in the same organization", () => {
    const hold = { organizationId: "org-a", contextKey: "chat:chat-1" };

    expect(resolveDisplayedSidePanelContext("/messenger/chat/chat-1", "org-a", hold)).toEqual({
      contextKey: "chat:chat-1",
      preserveHold: true,
    });
    expect(resolveDisplayedSidePanelContext("/messenger/saved/saved-1", "org-a", hold)).toEqual({
      contextKey: "chat:chat-1",
      preserveHold: true,
    });
    expect(resolveDisplayedSidePanelContext("/messenger/workbench", "org-a", hold)).toEqual({
      contextKey: "chat:chat-1",
      preserveHold: true,
    });
  });

  it("uses the organization-global context for direct or cross-organization workbench routes", () => {
    expect(resolveDisplayedSidePanelContext("/messenger/saved/saved-1", "org-a", null)).toEqual({
      contextKey: "organization:org-a:global",
      preserveHold: false,
    });
    expect(resolveDisplayedSidePanelContext(
      "/messenger/workbench",
      "org-b",
      { organizationId: "org-a", contextKey: "chat:chat-1" },
    )).toEqual({
      contextKey: "organization:org-b:global",
      preserveHold: false,
    });
  });

  it("clears a hold when navigating to another chat or issue", () => {
    const hold = { organizationId: "org-a", contextKey: "chat:chat-1" };

    expect(resolveDisplayedSidePanelContext("/messenger/chat/chat-2", "org-a", hold)).toEqual({
      contextKey: "chat:chat-2",
      preserveHold: false,
    });
    expect(resolveDisplayedSidePanelContext("/messenger/issues/RUD-42", "org-a", hold)).toEqual({
      contextKey: "issue:RUD-42",
      preserveHold: false,
    });
  });
});

describe("workspace main card framing", () => {
  it("keeps Messenger directory and chat routes frameless", () => {
    expect(shouldUseFramelessWorkspaceMain("/messenger")).toBe(true);
    expect(shouldUseFramelessWorkspaceMain("/messenger/chat")).toBe(true);
    expect(shouldUseFramelessWorkspaceMain("/messenger/chat/chat-1")).toBe(true);
  });

  it("keeps Messenger thread routes on the normal paper workspace card", () => {
    expect(shouldUseFramelessWorkspaceMain("/messenger/approvals")).toBe(false);
    expect(shouldUseFramelessWorkspaceMain("/messenger/system/failed-runs")).toBe(false);
    expect(shouldUseFramelessWorkspaceMain("/messenger/issues")).toBe(false);
    expect(shouldUseFramelessWorkspaceMain("/messenger/issues/issue-1")).toBe(false);
  });

  it("keeps Library routes frameless without affecting workspace backups", () => {
    expect(shouldUseFramelessWorkspaceMain("/library")).toBe(true);
    expect(shouldUseFramelessWorkspaceMain("/workspaces/backups")).toBe(false);
  });

  it("lets Automations own its outer list and detail cards", () => {
    expect(shouldUseFramelessWorkspaceMain("/automations")).toBe(true);
    expect(shouldUseFramelessWorkspaceMain("/automations/automation-1")).toBe(true);
  });
});
