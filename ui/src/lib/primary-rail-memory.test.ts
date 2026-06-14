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
    expect(resolvePrimaryRailSection("/dashboard/calendar")).toBe("dashboard");
    expect(resolvePrimaryRailSection("/projects/rudder/issues")).toBe("organization");
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

  it("falls back when no safe path exists for the section", () => {
    rememberPrimaryRailPath("org-1", "/issues/ZST-586");

    expect(readRememberedPrimaryRailPath("org-1", "dashboard", "/dashboard")).toBe("/dashboard");
    expect(readRememberedPrimaryRailPath(null, "issues", "/issues")).toBe("/issues");
  });
});
