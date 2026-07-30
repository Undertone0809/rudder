import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BUILD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "build");

function readPngSize(fileName: string): { width: number; height: number } {
  const bytes = fs.readFileSync(path.join(BUILD_DIR, fileName));
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function sha256(fileName: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(path.join(BUILD_DIR, fileName)))
    .digest("hex");
}

describe("macOS menu bar icon assets", () => {
  it("uses the Rudder ring, arc, and pointer instead of the legacy placeholder", () => {
    const svg = fs.readFileSync(path.join(BUILD_DIR, "trayTemplate.svg"), "utf8");

    expect(svg).toContain('data-rudder-mark="outer-ring"');
    expect(svg).toContain('data-rudder-mark="inner-arc"');
    expect(svg).toContain('data-rudder-mark="pointer"');
    expect(svg).not.toContain("<circle cx=\"4.45\"");
  });

  it("keeps committed 1x and 2x template images in sync with the reviewed mark", () => {
    expect(readPngSize("trayTemplate.png")).toEqual({ width: 18, height: 18 });
    expect(readPngSize("trayTemplate@2x.png")).toEqual({ width: 36, height: 36 });
    expect(sha256("trayTemplate.png")).toBe(
      "ece45c754e10854f5f431867f0337cac990534ee8305b1d0ca781854bf5c0ec5",
    );
    expect(sha256("trayTemplate@2x.png")).toBe(
      "c3e7486c740de80d3f700fa4123d0cb895e2cd19a0497feb09f7d5f799ba4e69",
    );
  });
});
