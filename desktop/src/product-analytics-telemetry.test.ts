import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateDesktopTelemetryState, updateDesktopTelemetryState } from "./product-analytics-telemetry.js";

describe("desktop product analytics telemetry state", () => {
  it("creates stable local installation identity with restrictive permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-telemetry-"));
    const first = await loadOrCreateDesktopTelemetryState(root);
    const second = await loadOrCreateDesktopTelemetryState(root);
    expect(second.installationId).toBe(first.installationId);
    expect(second.installationSecret).toBe(first.installationSecret);
    expect(first.state.mode).toBe("off");
    expect((await stat(first.statePath)).mode & 0o777).toBe(0o600);
    const raw = await readFile(first.statePath, "utf8");
    expect(raw).not.toContain("prompt");
  });

  it("updates only local delivery state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-telemetry-"));
    const first = await loadOrCreateDesktopTelemetryState(root);
    const updated = await updateDesktopTelemetryState(first.statePath, { mode: "anonymous", lastErrorCode: "offline" });
    expect(updated.mode).toBe("anonymous");
    expect(updated.lastErrorCode).toBe("offline");
    expect(updated.installationSecret).toBe(first.installationSecret);
  });
});
