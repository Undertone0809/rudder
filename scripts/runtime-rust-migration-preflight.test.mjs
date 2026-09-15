import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

function runTsx(args) {
  return execFileSync(process.execPath, ["cli/node_modules/tsx/dist/cli.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

describe("Rust migration append preparation", () => {
  it("runs the actual-helper regression suite in normal repository qualification", () => {
    const output = runTsx([
      "--test",
      "--test-reporter=tap",
      "scripts/rust-d1-migration-append-preflight.test.ts",
    ]);
    expect(output).toMatch(/# pass [1-9][0-9]*/);
    expect(output).toContain("# fail 0");
    expect(output).toContain("# skipped 0");
  }, 40_000);

  it("accepts a disposable append of the complete current repository journal", () => {
    const report = JSON.parse(runTsx(["scripts/rust-d1-migration-append-preflight.ts"]));
    expect(report.status).toBe("ready");
    expect(report.sourceUnchanged).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.reportedAddedFiles).toHaveLength(1);
    expect(report.reportedAddedFiles[0]).toMatch(/_rust_d1_append_probe\.sql$/);
    expect(report.legacyUnjournaledFiles).toEqual([
      "0055_illegal_sheva_callister.sql",
      "0128_modern_jetstream.sql",
    ]);
  }, 40_000);
});
