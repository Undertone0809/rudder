import { describe, expect, it } from "vitest";
import { clampWorkspaceColumnWidth, getWorkspaceColumnMaxWidth } from "./Layout";

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
