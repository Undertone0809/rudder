import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "vitest";
import { runBenchmark } from "./workspace-backup-node-streaming.mjs";

const execFileAsync = promisify(execFile);

describe("workspace backup Node streaming comparator", () => {
  it("produces byte-identical bounded output to the materialized comparator", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-backup-fixture-"));
    const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-backup-output-"));
    await fsp.mkdir(path.join(root, "projects", "roadmap"), { recursive: true });
    await fsp.writeFile(path.join(root, "projects", "roadmap", "README.md"), "# Roadmap\n", "utf8");
    await fsp.writeFile(path.join(root, "projects", "roadmap", "large.bin"), Buffer.alloc(256 * 1024, 0x61));
    await fsp.writeFile(path.join(root, "ignored.tmp-123"), "partial\n", "utf8");

    try {
      const result = await runBenchmark(root, outputDir);
      assert.equal(result.byteParity, true);
      assert.equal(result.fileCount, 2);
      assert.equal(result.warnings.some((warning) => warning.includes("ignored.tmp-123")), true);
      await execFileAsync("unzip", ["-t", result.streaming.outputPath]);
      assert.deepEqual(await fsp.readFile(result.buffered.outputPath), await fsp.readFile(result.streaming.outputPath));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(outputDir, { recursive: true, force: true });
    }
  });
});
