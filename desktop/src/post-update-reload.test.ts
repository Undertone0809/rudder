import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPostUpdateReloadMarker,
  consumePostUpdateReloadMarker,
  resolvePostUpdateReloadDelayMs,
  resolvePostUpdateReloadMarkerPath,
  writePostUpdateReloadMarker,
} from "./post-update-reload.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-post-update-reload."));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("post-update reload marker", () => {
  it("writes and consumes a one-shot marker", () => {
    writePostUpdateReloadMarker(tempDir, { targetVersion: "0.2.6", updateId: "update-1" });

    const marker = consumePostUpdateReloadMarker(tempDir);

    expect(marker).toMatchObject({ version: 1, targetVersion: "0.2.6", updateId: "update-1" });
    expect(fs.existsSync(resolvePostUpdateReloadMarkerPath(tempDir))).toBe(false);
    expect(consumePostUpdateReloadMarker(tempDir)).toBeNull();
  });

  it("ignores stale markers and removes them", () => {
    fs.writeFileSync(
      resolvePostUpdateReloadMarkerPath(tempDir),
      JSON.stringify({ version: 1, requestedAt: "2026-05-19T00:00:00.000Z" }),
      "utf8",
    );

    const marker = consumePostUpdateReloadMarker(tempDir, {
      now: new Date("2026-05-19T01:00:01.000Z"),
      maxAgeMs: 60 * 60 * 1_000,
    });

    expect(marker).toBeNull();
    expect(fs.existsSync(resolvePostUpdateReloadMarkerPath(tempDir))).toBe(false);
  });

  it("clears an existing marker", () => {
    writePostUpdateReloadMarker(tempDir, { targetVersion: "0.2.6" });

    clearPostUpdateReloadMarker(tempDir);

    expect(fs.existsSync(resolvePostUpdateReloadMarkerPath(tempDir))).toBe(false);
  });

  it("resolves the reload delay from the environment", () => {
    expect(resolvePostUpdateReloadDelayMs({ RUDDER_DESKTOP_POST_UPDATE_RELOAD_DELAY_MS: "25" })).toBe(25);
    expect(resolvePostUpdateReloadDelayMs({ RUDDER_DESKTOP_POST_UPDATE_RELOAD_DELAY_MS: "-10" })).toBe(0);
    expect(resolvePostUpdateReloadDelayMs({ RUDDER_DESKTOP_POST_UPDATE_RELOAD_DELAY_MS: "nope" })).toBe(1_500);
  });
});
