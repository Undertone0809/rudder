import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  delete process.env.RUN_LOG_BASE_PATH;
  delete process.env.RUDDER_NATIVE_RUN_EVIDENCE_INDEX;
  delete process.env.RUDDER_NATIVE_EVIDENCE_INDEX_PATH;
  delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
  vi.resetModules();
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("log store offsets", () => {
  async function writeNativeIndexFixture(root: string, mode: "success" | "malformed") {
    const binary = path.join(root, "native-index.mjs");
    await fs.writeFile(binary, `#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
const args = process.argv.slice(2);
if (${JSON.stringify(mode)} === "malformed") { console.log("not-json"); process.exit(0); }
const input = args[2];
const output = args[3];
const source = fs.readFileSync(input);
const hash = crypto.createHash("sha256").update(source).digest("hex");
const lines = source.toString("utf8").trim().split(/\\n/).filter(Boolean);
fs.writeFileSync(output, lines.map((_, index) => JSON.stringify({ sequence: index, sourceOffset: 0, sourceLength: source.length, stream: "stdout", chunkBytes: 0, sha256: "0".repeat(64) })).join("\\n") + "\\n");
console.log(JSON.stringify({ ok: true, operation: "indexEvidence", protocolVersion: 1, sourceBytes: source.length, recordCount: lines.length, sourceSha256: hash, indexPath: output }));
`);
    await fs.chmod(binary, 0o755);
    return binary;
  }

  it("builds an opt-in native evidence index without changing the Node log result", async () => {
    const root = await makeTempRoot("rudder-run-log-native-index-");
    process.env.RUN_LOG_BASE_PATH = path.join(root, "run-logs");
    process.env.RUDDER_NATIVE_RUN_EVIDENCE_INDEX = "1";
    process.env.RUDDER_NATIVE_EVIDENCE_INDEX_PATH = await writeNativeIndexFixture(root, "success");
    vi.resetModules();
    const { getRunLogStore } = await import("../services/run-log-store.js");
    const store = getRunLogStore();
    const handle = await store.begin({ orgId: "org-1", agentId: "agent-1", runId: "run-native-index" });
    await store.append(handle, { ts: "2026-04-24T00:00:00.000Z", stream: "stdout", chunk: "indexed" });
    const summary = await store.finalize(handle);

    expect(summary.evidenceIndex).toMatchObject({ status: "native", indexRef: `${handle.logRef}.index.ndjson`, sourceBytes: summary.bytes, sourceSha256: summary.sha256 });
    await expect(fs.stat(path.join(root, "run-logs", `${handle.logRef}.index.ndjson`))).resolves.toBeTruthy();
    await expect(store.read(handle, { offset: 0, limitBytes: 256_000 })).resolves.toMatchObject({ eof: true });
  });

  it("fails closed to the Node finalize result when native indexing is unavailable", async () => {
    const root = await makeTempRoot("rudder-run-log-native-index-fallback-");
    process.env.RUN_LOG_BASE_PATH = path.join(root, "run-logs");
    process.env.RUDDER_NATIVE_RUN_EVIDENCE_INDEX = "1";
    process.env.RUDDER_NATIVE_EVIDENCE_INDEX_PATH = await writeNativeIndexFixture(root, "malformed");
    vi.resetModules();
    const { getRunLogStore } = await import("../services/run-log-store.js");
    const store = getRunLogStore();
    const handle = await store.begin({ orgId: "org-1", agentId: "agent-1", runId: "run-native-index-fallback" });
    await store.append(handle, { ts: "2026-04-24T00:00:00.000Z", stream: "stderr", chunk: "fallback" });
    const summary = await store.finalize(handle);

    expect(summary.bytes).toBeGreaterThan(0);
    expect(summary.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.evidenceIndex).toMatchObject({ status: "fallback", indexRef: `${handle.logRef}.index.ndjson` });
    await expect(fs.stat(path.join(root, "run-logs", `${handle.logRef}.index.ndjson`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports run log offsets as bytes for UTF-8 content", async () => {
    const root = await makeTempRoot("rudder-run-log-offsets-");
    process.env.RUN_LOG_BASE_PATH = path.join(root, "run-logs");
    vi.resetModules();
    const { getRunLogStore } = await import("../services/run-log-store.js");
    const store = getRunLogStore();
    const handle = await store.begin({ orgId: "org-1", agentId: "agent-1", runId: "run-1" });

    await store.append(handle, {
      ts: "2026-04-24T00:00:00.000Z",
      stream: "stdout",
      chunk: "hello 中文",
    });

    const result = await store.read(handle, { offset: 0, limitBytes: 256_000 });
    const summary = await store.finalize(handle);

    expect(result.content).toContain("中文");
    expect(result.content.length).toBeLessThan(summary.bytes);
    expect(result.endOffset).toBe(summary.bytes);
    expect(result.eof).toBe(true);
    expect(result.nextOffset).toBeUndefined();
  });

  it("keeps UTF-8 code points intact across small run log pages", async () => {
    const root = await makeTempRoot("rudder-run-log-utf8-pages-");
    process.env.RUN_LOG_BASE_PATH = path.join(root, "run-logs");
    vi.resetModules();
    const { getRunLogStore } = await import("../services/run-log-store.js");
    const store = getRunLogStore();
    const handle = await store.begin({ orgId: "org-1", agentId: "agent-1", runId: "run-utf8" });
    await store.append(handle, {
      ts: "2026-04-24T00:00:00.000Z",
      stream: "stdout",
      chunk: "中文日志分页完整",
    });
    const summary = await store.finalize(handle);
    const full = await store.read(handle, { offset: 0, limitBytes: summary.bytes });

    const pages: string[] = [];
    let offset = 0;
    for (let index = 0; index < summary.bytes; index += 1) {
      const page = await store.read(handle, { offset, limitBytes: 4 });
      pages.push(page.content);
      expect(page.content).not.toContain("\uFFFD");
      if (page.eof) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset!;
    }

    expect(pages.join("")).toBe(full.content);
  });

  it("reports workspace operation log offsets as bytes for UTF-8 content", async () => {
    const root = await makeTempRoot("rudder-workspace-operation-log-offsets-");
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = path.join(root, "workspace-operation-logs");
    vi.resetModules();
    const { getWorkspaceOperationLogStore } = await import("../services/workspace-operation-log-store.js");
    const store = getWorkspaceOperationLogStore();
    const handle = await store.begin({ orgId: "org-1", operationId: "operation-1" });

    await store.append(handle, {
      ts: "2026-04-24T00:00:00.000Z",
      stream: "stderr",
      chunk: "step 完成",
    });

    const result = await store.read(handle, { offset: 0, limitBytes: 256_000 });
    const summary = await store.finalize(handle);

    expect(result.content).toContain("完成");
    expect(result.content.length).toBeLessThan(summary.bytes);
    expect(result.endOffset).toBe(summary.bytes);
    expect(result.eof).toBe(true);
    expect(result.nextOffset).toBeUndefined();
  });
});
