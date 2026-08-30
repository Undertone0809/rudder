import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalAppRuntimeLogStore } from "./local-app-runtime-log-store.js";

describe("Local App runtime log store", () => {
  it("coalesces mode-private bounded UTF-8 snapshots and clears them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-logs-"));
    const store = new LocalAppRuntimeLogStore({ directory: root, maxBytes: 16, flushDelayMs: 1_000 });
    store.schedule("binding-a", "obsolete");
    store.schedule("binding-a", `prefix-${"界".repeat(8)}`);
    await store.flush("binding-a");

    const restored = await store.read("binding-a");
    expect(restored.endsWith("界")).toBe(true);
    expect(Buffer.byteLength(restored)).toBeLessThanOrEqual(16);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    const files = await readdir(root);
    expect(files).toHaveLength(1);
    expect((await stat(path.join(root, files[0]!))).mode & 0o777).toBe(0o600);

    await store.clear("binding-a");
    await expect(store.read("binding-a")).resolves.toBe("");
  });
});
