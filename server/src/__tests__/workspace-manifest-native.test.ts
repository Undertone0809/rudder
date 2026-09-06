import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readNativeWorkspaceManifest,
  stopNativeWorkspaceManifestWatchersForTests,
} from "../services/workspace-manifest-native.js";

const ENV_KEYS = [
  "RUDDER_HOME",
  "RUDDER_INSTANCE_ID",
  "RUDDER_NATIVE_MODE",
  "RUDDER_NATIVE_WORKSPACE_MANIFEST_PATH",
] as const;

const previousEnvironment = new Map<string, string | undefined>();
let activeFixture: string | undefined;

afterEach(async () => {
  await stopNativeWorkspaceManifestWatchersForTests();
  if (activeFixture) await fs.rm(activeFixture, { recursive: true, force: true });
  activeFixture = undefined;
  for (const key of ENV_KEYS) {
    const value = previousEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnvironment.clear();
});

function rememberEnvironment() {
  for (const key of ENV_KEYS) previousEnvironment.set(key, process.env[key]);
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for native workspace manifest update");
}

describe("native workspace manifest public command", () => {
  it("reads the staged watcher and converges after a mutation", async () => {
    rememberEnvironment();
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-native-manifest-test-"));
    activeFixture = fixture;
    const workspace = path.join(fixture, "workspace");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "alpha.txt"), "alpha\n");

    process.env.RUDDER_HOME = fixture;
    process.env.RUDDER_INSTANCE_ID = "manifest-test";
    process.env.RUDDER_NATIVE_MODE = "required";
    process.env.RUDDER_NATIVE_WORKSPACE_MANIFEST_PATH ??= path.resolve(
      process.cwd(),
      "native/target/debug/rudder-native",
    );

    const initial = await readNativeWorkspaceManifest(workspace);
    expect(initial?.map((entry) => entry.path)).toContain("alpha.txt");

    await fs.mkdir(path.join(workspace, "nested"));
    await fs.writeFile(path.join(workspace, "nested", "beta.txt"), "beta\n");
    const updated = await waitFor(
      () => readNativeWorkspaceManifest(workspace),
      (value) => value?.some((entry) => entry.path === "nested/beta.txt") === true,
    );
    expect(updated?.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["alpha.txt", "nested", "nested/beta.txt"]),
    );
  });

  it.runIf(process.platform !== "win32")("rejects a manifest containing invalid UTF-8", async () => {
    rememberEnvironment();
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-native-manifest-invalid-utf8-"));
    activeFixture = fixture;
    const workspace = path.join(fixture, "workspace");
    await fs.mkdir(workspace);
    const fakeBinary = path.join(fixture, "fake-native");
    await fs.writeFile(
      fakeBinary,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const rootPath = process.argv[4];",
        "const manifestPath = process.argv[5];",
        "const manifest = JSON.stringify({ protocolVersion: 1, state: 'ready', rootPath, entries: [] });",
        "fs.writeFileSync(manifestPath, Buffer.concat([Buffer.from(manifest), Buffer.from([0xff])]));",
        "process.stdout.write(JSON.stringify({ ok: true, capability: 'workspace.watch', protocolVersion: 1, state: 'ready' }) + '\\n');",
        "process.stdin.resume();",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    process.env.RUDDER_HOME = fixture;
    process.env.RUDDER_INSTANCE_ID = "manifest-invalid-utf8";
    process.env.RUDDER_NATIVE_MODE = "required";
    process.env.RUDDER_NATIVE_WORKSPACE_MANIFEST_PATH = fakeBinary;

    await expect(readNativeWorkspaceManifest(workspace)).rejects.toMatchObject({
      diagnostic: { fallbackCode: "invalid_manifest" },
    });
  });
});
