// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  appLocationActionErrorTitle,
  appLocationActionLabel,
  shouldPreserveAppDirectOpenDuringOrganizationChange,
} from "./apps-workspace";

describe("Apps workspace organization changes", () => {
  it("preserves a targeted App route while a fresh direct-open intent is pending", () => {
    expect(shouldPreserveAppDirectOpenDuringOrganizationChange(
      "managed:target-app",
      4,
    )).toBe(true);
  });

  it("resets ordinary organization changes and Apps home routes", () => {
    expect(shouldPreserveAppDirectOpenDuringOrganizationChange(
      "managed:target-app",
      0,
    )).toBe(false);
    expect(shouldPreserveAppDirectOpenDuringOrganizationChange("home", 4)).toBe(false);
  });
});

describe("App source location actions", () => {
  it("keeps unbound managed Apps in Rudder Library", () => {
    expect(appLocationActionLabel(false, "darwin")).toBe("Open source");
    expect(appLocationActionErrorTitle(false, "darwin")).toBe("Could not open App source");
  });

  it.each([
    ["darwin", "Open in Finder", "Could not open App in Finder"],
    ["win32", "Open in File Explorer", "Could not open App in File Explorer"],
    ["linux", "Open in File Manager", "Could not open App in File Manager"],
  ] as const)("uses the native folder label on %s", (platform, label, errorTitle) => {
    expect(appLocationActionLabel(true, platform)).toBe(label);
    expect(appLocationActionErrorTitle(true, platform)).toBe(errorTitle);
  });

  it("uses a platform-neutral folder label for unsupported platforms", () => {
    expect(appLocationActionLabel(true, "freebsd")).toBe("Open in File Manager");
    expect(appLocationActionErrorTitle(true, "freebsd")).toBe("Could not open App in File Manager");
  });
});