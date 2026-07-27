// @vitest-environment node

import { beforeEach, describe, expect, it } from "vitest";
import {
  readRememberedPrimaryRailPath,
  rememberPrimaryRailPath,
  resolvePrimaryRailSection,
  sanitizePrimaryRailPath,
} from "./primary-rail-memory";

const storage = new Map<string, string>();

Object.defineProperty(globalThis, "window", {
  value: globalThis,
  configurable: true,
});

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
  },
  configurable: true,
});

describe("primary rail memory", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("maps nested routes to their primary rail section", () => {
    expect(resolvePrimaryRailSection("/issues/ZST-586")).toBe("issues");
    expect(resolvePrimaryRailSection("/agents/wesley/runs/run-1")).toBe("agents");
    expect(resolvePrimaryRailSection("/dashboard/calendar")).toBe("organization");
    expect(resolvePrimaryRailSection("/projects/rudder/issues")).toBe("organization");
    expect(resolvePrimaryRailSection("/skills/skill-123/files/SKILL.md")).toBeNull();
    expect(resolvePrimaryRailSection("/automations/weekly-ci")).toBe("automations");
    expect(resolvePrimaryRailSection("/organization/settings")).toBeNull();
  });

  it("preserves query and hash only for paths inside the requested section", () => {
    expect(sanitizePrimaryRailPath("issues", "/issues/ZST-586?tab=activity#latest")).toBe(
      "/issues/ZST-586?tab=activity#latest",
    );
    expect(sanitizePrimaryRailPath("issues", "/agents/wesley")).toBeNull();
    expect(sanitizePrimaryRailPath("issues", "issues/ZST-586")).toBeNull();
  });

  it("stores remembered paths per organization and section", () => {
    rememberPrimaryRailPath("org-1", "/issues/ZST-586");
    rememberPrimaryRailPath("org-1", "/agents/wesley/runs/run-1");
    rememberPrimaryRailPath("org-2", "/issues/ZST-100");

    expect(readRememberedPrimaryRailPath("org-1", "issues", "/issues")).toBe("/issues/ZST-586");
    expect(readRememberedPrimaryRailPath("org-1", "agents", "/agents")).toBe("/agents/wesley/runs/run-1");
    expect(readRememberedPrimaryRailPath("org-2", "issues", "/issues")).toBe("/issues/ZST-100");
  });

  it("does not remember workspace backups as the Library rail destination", () => {
    rememberPrimaryRailPath("org-1", "/library?path=plans%2Froadmap.md");
    rememberPrimaryRailPath("org-1", "/workspaces/backups?backup=backup-1");

    expect(readRememberedPrimaryRailPath("org-1", "library", "/library")).toBe(
      "/library?path=plans%2Froadmap.md",
    );
  });

  it("falls back when no safe path exists for the section", () => {
    rememberPrimaryRailPath("org-1", "/issues/ZST-586");

    expect(readRememberedPrimaryRailPath("org-1", "organization", "/dashboard")).toBe("/dashboard");
    expect(readRememberedPrimaryRailPath(null, "issues", "/issues")).toBe("/issues");
  });

  it("does not remember legacy skills routes as the Organization rail destination", () => {
    rememberPrimaryRailPath("org-1", "/dashboard");
    rememberPrimaryRailPath("org-1", "/skills/skill-123/files/SKILL.md");

    expect(readRememberedPrimaryRailPath("org-1", "organization", "/dashboard")).toBe("/dashboard");
    expect(readRememberedPrimaryRailPath("org-1", "library", "/library")).toBe("/library");
  });

  it("rejects the removed Organization workspace redirect as a rail destination", () => {
    storage.set("rudder.primaryRailLastPaths", JSON.stringify({
      "org-1": { organization: "/org?legacy=1#old" },
    }));

    expect(sanitizePrimaryRailPath("organization", "/org")).toBeNull();
    expect(sanitizePrimaryRailPath("organization", "/org/")).toBeNull();
    expect(sanitizePrimaryRailPath("organization", "/org?legacy=1#old")).toBeNull();
    expect(readRememberedPrimaryRailPath("org-1", "organization", "/dashboard")).toBe("/dashboard");
  });
});
