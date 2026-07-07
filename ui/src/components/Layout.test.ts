import { describe, expect, it } from "vitest";
import {
  clampWorkspaceColumnWidth,
  getWorkspaceColumnMaxWidth,
  resolveProportionalSidePanelWidth,
  resolveProportionalWorkspaceColumnWidth,
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

  it("keeps proportional side panel width inside min and viewport limits", () => {
    const ratio = 420 / 1440;

    expect(resolveProportionalSidePanelWidth(ratio, 1000)).toBe(340);
    expect(resolveProportionalSidePanelWidth(720 / 1440, 1440)).toBe(604);
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
});
