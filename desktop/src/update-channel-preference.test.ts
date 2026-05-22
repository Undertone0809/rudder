import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeDesktopUpdateChannel,
  readDesktopUpdateChannel,
  writeDesktopUpdateChannel,
} from "./update-channel-preference.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-update-channel-"));
  tempDirs.push(dir);
  return dir;
}

describe("desktop update channel preference", () => {
  it("normalizes invalid values to stable", () => {
    expect(normalizeDesktopUpdateChannel("canary")).toBe("canary");
    expect(normalizeDesktopUpdateChannel("stable")).toBe("stable");
    expect(normalizeDesktopUpdateChannel("nightly")).toBe("stable");
    expect(normalizeDesktopUpdateChannel(null)).toBe("stable");
  });

  it("defaults missing or invalid preference files to stable", () => {
    const dir = makeTempDir();
    expect(readDesktopUpdateChannel(dir)).toBe("stable");

    fs.writeFileSync(path.join(dir, "desktop-update-channel.json"), JSON.stringify({ channel: "nightly" }));
    expect(readDesktopUpdateChannel(dir)).toBe("stable");
  });

  it("persists the selected channel", () => {
    const dir = makeTempDir();
    expect(writeDesktopUpdateChannel(dir, "canary")).toBe("canary");
    expect(readDesktopUpdateChannel(dir)).toBe("canary");

    expect(writeDesktopUpdateChannel(dir, "stable")).toBe("stable");
    expect(readDesktopUpdateChannel(dir)).toBe("stable");
  });
});
