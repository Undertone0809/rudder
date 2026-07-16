import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertDesktopUpdateMaintenanceAccess } from "../desktop-update-maintenance.js";

const roots: string[] = [];

function createLock(contents: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-desktop-maintenance-"));
  roots.push(root);
  const lockPath = path.join(root, "desktop-update-maintenance.json");
  fs.writeFileSync(lockPath, contents);
  return lockPath;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Desktop update maintenance lock", () => {
  it("allows normal runtime startup when no update lock exists", () => {
    expect(() => assertDesktopUpdateMaintenanceAccess({
      lockPath: "/path/that/does/not/exist",
      instanceId: "default",
    })).not.toThrow();
  });

  it("allows only the candidate runtime that owns the update lock", () => {
    const lockPath = createLock(JSON.stringify({ updateId: "update-1" }));

    expect(() => assertDesktopUpdateMaintenanceAccess({
      lockPath,
      instanceId: "default",
      desktopUpdateId: "update-1",
    })).not.toThrow();
    expect(() => assertDesktopUpdateMaintenanceAccess({
      lockPath,
      instanceId: "default",
      desktopUpdateId: "other-update",
    })).toThrow("locked while Rudder finishes Desktop update recovery");
  });

  it("fails closed when the update lock is unreadable or invalid", () => {
    const lockPath = createLock("not-json");

    expect(() => assertDesktopUpdateMaintenanceAccess({
      lockPath,
      instanceId: "default",
      desktopUpdateId: "update-1",
    })).toThrow("locked while Rudder finishes Desktop update recovery");
  });
});
