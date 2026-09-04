import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempRoots: string[] = [];
const initialNativeMode = process.env.RUDDER_NATIVE_MODE;

type EvidenceReadFixture = {
  source: string;
  cases: Array<{
    offset: number;
    limitBytes: number;
    content: string;
    endOffset: number;
    eof: boolean;
    nextOffset: number | null;
  }>;
};

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  if (initialNativeMode === undefined) delete process.env.RUDDER_NATIVE_MODE;
  else process.env.RUDDER_NATIVE_MODE = initialNativeMode;
  delete process.env.RUN_LOG_BASE_PATH;
  delete process.env.RUDDER_NATIVE_RUN_EVIDENCE_INDEX;
  delete process.env.RUDDER_NATIVE_EVIDENCE_INDEX_PATH;
  delete process.env.RUDDER_NATIVE_EVIDENCE_READ_TIMEOUT_MS;
  delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
  vi.resetModules();
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("log store offsets", () => {
  async function writeNativeIndexFixture(
    root: string,
    mode: "success" | "malformed" | "hang" | "not-found" | "invalid-utf8",
  ) {
    const binary = path.join(root, "native-index.mjs");
    await fs.writeFile(binary, `#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
const args = process.argv.slice(2);
if (${JSON.stringify(mode)} === "hang" && args[1] === "read") { setInterval(() => {}, 1000); }
if (["not-found", "invalid-utf8"].includes(${JSON.stringify(mode)}) && args[1] === "read") {
  const errorCode = ${JSON.stringify(mode)} === "not-found" ? "evidence_read_not_found" : "evidence_read_invalid_utf8";
  console.log(JSON.stringify({ ok: false, capability: "evidence.read", protocolVersion: 1, errorCode, accepted: false }));
  console.error("rudder-native: operation failed");
  process.exit(2);
}
if (${JSON.stringify(mode)} === "malformed") { console.log("not-json"); process.exit(0); }
const input = args[2];
if (args[1] === "read") {
  const source = fs.readFileSync(input);
  const offset = Math.min(Number(args[3]), source.length);
  const limit = Math.max(4, Number(args[4]));
  const bytes = source.subarray(offset, Math.min(offset + limit, source.length));
  let leading = 0;
  while (leading < bytes.length && (bytes[leading] & 0xc0) === 0x80) leading += 1;
  const decodable = bytes.subarray(leading);
  let content;
  let decodedBytes;
  for (let trim = 0; trim <= Math.min(3, decodable.length); trim += 1) {
    try {
      decodedBytes = decodable.length - trim;
      content = new TextDecoder("utf-8", { fatal: true }).decode(decodable.subarray(0, decodedBytes));
      break;
    } catch {}
  }
  const endOffset = offset + leading + decodedBytes;
  const eof = endOffset >= source.length;
  console.log(JSON.stringify({ ok: true, capability: "evidence.read", operation: "readEvidence", protocolVersion: 1, target: "test", binaryVersion: "test", content, endOffset, eof, nextOffset: eof ? null : endOffset }));
  process.exit(0);
}
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
    const previousMode = process.env.RUDDER_NATIVE_MODE;
    process.env.RUN_LOG_BASE_PATH = path.join(root, "run-logs");
    process.env.RUDDER_NATIVE_MODE = "auto";
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
    await expect(store.read(handle, { offset: 0, limitBytes: 256_000 })).resolves.toMatchObject({
      content: expect.stringContaining("fallback"),
      eof: true,
    });
    if (previousMode === undefined) delete process.env.RUDDER_NATIVE_MODE;
    else process.env.RUDDER_NATIVE_MODE = previousMode;
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

  it("matches the shared API, CLI, and MCP byte-page fixture through native read authority", async () => {
    const root = await makeTempRoot("rudder-run-log-native-read-");
    const fixture = JSON.parse(await fs.readFile(
      new URL("../../../native/fixtures/run-evidence-read-parity.json", import.meta.url),
      "utf8",
    )) as EvidenceReadFixture;
    process.env.RUN_LOG_BASE_PATH = path.join(root, "run-logs");
    process.env.RUDDER_NATIVE_MODE = "required";
    process.env.RUDDER_NATIVE_RUN_EVIDENCE_INDEX = "1";
    process.env.RUDDER_NATIVE_EVIDENCE_INDEX_PATH = await writeNativeIndexFixture(root, "success");
    vi.resetModules();
    const { getRunLogStore } = await import("../services/run-log-store.js");
    const store = getRunLogStore();
    const handle = await store.begin({ orgId: "org-1", agentId: "agent-1", runId: "run-parity" });
    await fs.writeFile(path.join(process.env.RUN_LOG_BASE_PATH, handle.logRef), fixture.source);

    for (const testCase of fixture.cases) {
      await expect(store.read(handle, testCase)).resolves.toEqual({
        content: testCase.content,
        endOffset: testCase.endOffset,
        eof: testCase.eof,
        ...(testCase.nextOffset === null ? {} : { nextOffset: testCase.nextOffset }),
      });
    }
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

  it("terminates an over-deadline native read before applying required-mode failure", async () => {
    const root = await makeTempRoot("rudder-run-log-native-read-timeout-");
    process.env.RUN_LOG_BASE_PATH = path.join(root, "run-logs");
    process.env.RUDDER_NATIVE_MODE = "required";
    process.env.RUDDER_NATIVE_RUN_EVIDENCE_INDEX = "1";
    process.env.RUDDER_NATIVE_EVIDENCE_READ_TIMEOUT_MS = "10";
    process.env.RUDDER_NATIVE_EVIDENCE_INDEX_PATH = await writeNativeIndexFixture(root, "hang");
    vi.resetModules();
    const { getRunLogStore } = await import("../services/run-log-store.js");
    const store = getRunLogStore();
    const handle = await store.begin({ orgId: "org-1", agentId: "agent-1", runId: "run-timeout" });
    await fs.writeFile(path.join(process.env.RUN_LOG_BASE_PATH, handle.logRef), "deadline");

    await expect(store.read(handle, { offset: 0, limitBytes: 4 })).rejects.toThrow(/timeout/);
  });

  it("propagates request cancellation to the native child without fallback", async () => {
    const root = await makeTempRoot("rudder-run-log-native-read-cancel-");
    process.env.RUN_LOG_BASE_PATH = path.join(root, "run-logs");
    process.env.RUDDER_NATIVE_MODE = "auto";
    process.env.RUDDER_NATIVE_RUN_EVIDENCE_INDEX = "1";
    process.env.RUDDER_NATIVE_EVIDENCE_INDEX_PATH = await writeNativeIndexFixture(root, "hang");
    vi.resetModules();
    const { getRunLogStore } = await import("../services/run-log-store.js");
    const store = getRunLogStore();
    const handle = await store.begin({ orgId: "org-1", agentId: "agent-1", runId: "run-cancel" });
    await fs.writeFile(path.join(process.env.RUN_LOG_BASE_PATH, handle.logRef), "cancelled");
    const cancellation = new AbortController();
    const result = store.read(handle, { offset: 0, limitBytes: 4, signal: cancellation.signal });
    setTimeout(() => cancellation.abort(), 25);

    await expect(result).rejects.toThrow(/cancelled/);
  });

  it("preserves structured native errors and auto fallback semantics", async () => {
    const root = await makeTempRoot("rudder-run-log-native-read-errors-");
    process.env.RUN_LOG_BASE_PATH = path.join(root, "run-logs");
    process.env.RUDDER_NATIVE_MODE = "required";
    process.env.RUDDER_NATIVE_RUN_EVIDENCE_INDEX = "1";
    process.env.RUDDER_NATIVE_EVIDENCE_INDEX_PATH = await writeNativeIndexFixture(root, "not-found");
    vi.resetModules();
    let module = await import("../services/run-log-store.js");
    let store = module.getRunLogStore();
    let handle = await store.begin({ orgId: "org-1", agentId: "agent-1", runId: "run-missing" });
    await fs.rm(path.join(process.env.RUN_LOG_BASE_PATH, handle.logRef));
    await expect(store.read(handle, { offset: 0, limitBytes: 4 })).rejects.toMatchObject({ status: 404 });

    process.env.RUDDER_NATIVE_EVIDENCE_INDEX_PATH = await writeNativeIndexFixture(root, "invalid-utf8");
    vi.resetModules();
    module = await import("../services/run-log-store.js");
    store = module.getRunLogStore();
    handle = await store.begin({ orgId: "org-1", agentId: "agent-1", runId: "run-invalid" });
    await expect(store.read(handle, { offset: 0, limitBytes: 4 })).rejects.toThrow("evidence_read_invalid_utf8");

    process.env.RUDDER_NATIVE_MODE = "auto";
    vi.resetModules();
    module = await import("../services/run-log-store.js");
    store = module.getRunLogStore();
    handle = await store.begin({ orgId: "org-1", agentId: "agent-1", runId: "run-fallback" });
    await fs.writeFile(path.join(process.env.RUN_LOG_BASE_PATH, handle.logRef), "node-fallback");
    await expect(store.read(handle, { offset: 0, limitBytes: 64 })).resolves.toMatchObject({
      content: "node-fallback",
      eof: true,
    });
  });

  it("keeps oversized non-surface readers on Node authority in required mode", async () => {
    const root = await makeTempRoot("rudder-run-log-node-large-read-");
    process.env.RUN_LOG_BASE_PATH = path.join(root, "run-logs");
    process.env.RUDDER_NATIVE_MODE = "required";
    process.env.RUDDER_NATIVE_RUN_EVIDENCE_INDEX = "1";
    process.env.RUDDER_NATIVE_EVIDENCE_INDEX_PATH = await writeNativeIndexFixture(root, "hang");
    vi.resetModules();
    const { getRunLogStore } = await import("../services/run-log-store.js");
    const store = getRunLogStore();
    const handle = await store.begin({ orgId: "org-1", agentId: "agent-1", runId: "run-large-reader" });
    await fs.writeFile(path.join(process.env.RUN_LOG_BASE_PATH, handle.logRef), "node-owned");

    await expect(store.read(handle, { offset: 0, limitBytes: 2_000_000 })).resolves.toMatchObject({
      content: "node-owned",
      eof: true,
    });
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
