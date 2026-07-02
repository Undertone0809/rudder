import { describe, expect, it } from "vitest";
import { clampWorkspaceColumnWidth, getWorkspaceColumnMaxWidth, shouldUseFramelessWorkspaceMain } from "./Layout";

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
});

describe("workspace main card framing", () => {
  it("keeps Messenger directory and chat routes frameless", () => {
    expect(shouldUseFramelessWorkspaceMain("/messenger")).toBe(true);
    expect(shouldUseFramelessWorkspaceMain("/messenger/chat/chat-1")).toBe(true);
  });

  it("keeps Messenger issue detail routes on the normal paper workspace card", () => {
    expect(shouldUseFramelessWorkspaceMain("/messenger/issues/issue-1")).toBe(false);
  });

  it("keeps Library routes frameless without affecting workspace backups", () => {
    expect(shouldUseFramelessWorkspaceMain("/library")).toBe(true);
    expect(shouldUseFramelessWorkspaceMain("/workspaces/backups")).toBe(false);
  });
});
