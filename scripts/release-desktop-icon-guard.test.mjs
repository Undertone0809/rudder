import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("desktop release icon guard", () => {
  it("keeps Windows executable resource editing enabled so the Rudder icon is embedded", () => {
    const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "desktop-release.yml"), "utf8");
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "desktop", "package.json"), "utf8"));

    expect(workflow).not.toContain("signAndEditExecutable = false");
    expect(workflow).not.toContain('"signAndEditExecutable": false');
    expect(manifest.build?.win?.signAndEditExecutable).not.toBe(false);
    expect(manifest.build?.win?.icon).toBe("build/icon.ico");
  });

  it("ships runtime icon assets for packaged non-macOS windows and tray controls", () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "desktop", "package.json"), "utf8"));
    const resourceTargets = new Set((manifest.build.extraResources ?? []).map((entry) => entry.to));

    expect(resourceTargets).toContain("icon.png");
    expect(resourceTargets).toContain("icon.ico");
  });
});
