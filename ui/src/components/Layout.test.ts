import { describe, expect, it } from "vitest";
import {
  clampWorkspaceColumnWidth,
  getWorkspaceColumnMaxWidth,
  resolveDefaultSidePanelWidth,
  resolveProportionalSidePanelWidth,
  resolveProportionalWorkspaceColumnWidth,
  resolveSidePanelContextKey,
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

  it("scales the side panel from the saved viewport ratio", () => {
    const ratio = 420 / 1440;

    expect(resolveProportionalSidePanelWidth(ratio, 1200)).toBe(350);
    expect(resolveProportionalSidePanelWidth(ratio, 1440)).toBe(420);
  });

  it("defaults the side panel to half of the shared main workspace", () => {
    expect(resolveDefaultSidePanelWidth(1204, 1440)).toBe(600);
  });

  it("only auto-expands after the side panel exceeds a 2:1 ratio over main content", () => {
    expect(shouldAutoExpandSidePanel(800, 1200)).toBe(false);
    expect(shouldAutoExpandSidePanel(801, 1200)).toBe(true);
  });

  it("keeps proportional side panel width inside min and viewport limits", () => {
    const ratio = 420 / 1440;

    expect(resolveProportionalSidePanelWidth(ratio, 1000)).toBe(340);
    expect(resolveProportionalSidePanelWidth(720 / 1440, 1440)).toBe(604);
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

  it("keeps malformed route segments from crashing layout context resolution", () => {
    expect(resolveSidePanelContextKey("/messenger/chat/%E0%A4%A")).toBe("chat:%E0%A4%A");
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
