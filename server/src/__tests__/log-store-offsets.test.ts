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
  delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
  vi.resetModules();
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("log store offsets", () => {
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
