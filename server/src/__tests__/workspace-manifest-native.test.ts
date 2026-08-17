import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readNativeWorkspaceManifest,
  stopNativeWorkspaceManifestWatchersForTests,
} from "../services/workspace-manifest-native.js";

const roots: string[] = [];

async function tempRoot(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function fakeWatcher(root: string, mode: "ready" | "invalid") {
  const binary = path.join(root, `watch-${mode}.mjs`);
  await fs.writeFile(binary, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const workspace = args[2];
const output = args[3];
${mode === "ready" ? `fs.writeFileSync(output, JSON.stringify({ protocolVersion: 1, state: "ready", rootPath: workspace, generatedAtMillis: Date.now(), entries: [{ path: "notes/readme.md", kind: "file", byteSize: 4, modifiedMillis: 1 }] }) + "\\n");
console.log(JSON.stringify({ ok: true, capability: "workspace.watch", protocolVersion: 1, state: "ready" }));` : `fs.writeFileSync(output, "not-json\\n");
console.log(JSON.stringify({ ok: true, capability: "workspace.watch", protocolVersion: 1, state: "ready" }));`}
process.stdin.resume();
`, { mode: 0o755 });
  return binary;
}

async function waitForManifest(root: string) {
  for (let index = 0; index < 1_000; index += 1) {
    const result = await readNativeWorkspaceManifest(root);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("native manifest did not become ready");
}

afterEach(async () => {
  await stopNativeWorkspaceManifestWatchersForTests();
  delete process.env.RUDDER_HOME;
  delete process.env.RUDDER_INSTANCE_ID;
  delete process.env.RUDDER_NATIVE_MODE;
  delete process.env.RUDDER_NATIVE_WORKSPACE_MANIFEST_PATH;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("native workspace manifest integration", () => {
  it("starts the watcher by default and reads only a ready bounded manifest", async () => {
    const root = await tempRoot("rudder-native-manifest-");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    process.env.RUDDER_HOME = root;
    process.env.RUDDER_INSTANCE_ID = "test";
    process.env.RUDDER_NATIVE_WORKSPACE_MANIFEST_PATH = await fakeWatcher(root, "ready");

    await expect(waitForManifest(workspace)).resolves.toEqual([
      expect.objectContaining({ path: "notes/readme.md", kind: "file" }),
    ]);
  });

  it("deletes a corrupt manifest and falls back to live traversal in auto mode", async () => {
    const root = await tempRoot("rudder-native-manifest-corrupt-");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    process.env.RUDDER_HOME = root;
    process.env.RUDDER_INSTANCE_ID = "test";
    process.env.RUDDER_NATIVE_WORKSPACE_MANIFEST_PATH = await fakeWatcher(root, "invalid");

    for (let index = 0; index < 100; index += 1) {
      await readNativeWorkspaceManifest(workspace);
      const manifestDir = path.join(root, "instances", "test", "data", "native-workspace-manifests");
      const files = await fs.readdir(manifestDir).catch(() => []);
      if (files.length === 0 && index > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expect(readNativeWorkspaceManifest(workspace)).resolves.toBeNull();
  });

  it("honors the global Node rollback without spawning a watcher", async () => {
    const root = await tempRoot("rudder-native-manifest-node-");
    process.env.RUDDER_NATIVE_MODE = "node";
    process.env.RUDDER_NATIVE_WORKSPACE_MANIFEST_PATH = path.join(root, "missing");
    await expect(readNativeWorkspaceManifest(root)).resolves.toBeNull();
  });

  it("fails closed when required mode cannot start the watcher", async () => {
    const root = await tempRoot("rudder-native-manifest-required-");
    process.env.RUDDER_NATIVE_MODE = "required";
    process.env.RUDDER_NATIVE_WORKSPACE_MANIFEST_PATH = path.join(root, "missing");
    await expect(readNativeWorkspaceManifest(root)).rejects.toThrow(/unavailable/);
  });

  it("fails closed when required mode receives a corrupt ready manifest", async () => {
    const root = await tempRoot("rudder-native-manifest-required-corrupt-");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    process.env.RUDDER_HOME = root;
    process.env.RUDDER_INSTANCE_ID = "test";
    process.env.RUDDER_NATIVE_MODE = "required";
    process.env.RUDDER_NATIVE_WORKSPACE_MANIFEST_PATH = await fakeWatcher(root, "invalid");
    await expect(readNativeWorkspaceManifest(workspace)).rejects.toMatchObject({
      diagnostic: expect.objectContaining({ capability: "workspace-manifest", fallbackCode: "invalid_manifest" }),
    });
  }, 10_000);
});
