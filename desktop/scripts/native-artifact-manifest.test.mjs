import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NATIVE_ARTIFACTS,
  createNativeArtifactManifest,
  verifyNativeArtifactManifest,
  writeNativeArtifactManifest,
} from "./native-artifact-manifest.mjs";

const temporaryDirectories = [];

async function makeTargetRoot(platform = "darwin") {
  const root = await mkdtemp(path.join(os.tmpdir(), "rudder-native-artifacts-"));
  temporaryDirectories.push(root);
  const targetRoot = path.join(root, "aarch64-apple-darwin");
  await mkdir(targetRoot, { recursive: true });
  for (const [index, artifact] of NATIVE_ARTIFACTS.entries()) {
    const file = platform === "win32" ? `${artifact.name}.exe` : artifact.name;
    await writeFile(path.join(targetRoot, file), `binary-${index}`);
  }
  return targetRoot;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("native artifact manifest", () => {
  it("records and verifies every staged Rust binary, including CLI and MCP", async () => {
    const targetRoot = await makeTargetRoot();
    const manifestPath = path.join(targetRoot, "rudder-native-artifacts.json");
    const manifest = await createNativeArtifactManifest({
      version: "0.0.0-test",
      target: "aarch64-apple-darwin",
      platform: "darwin",
      arch: "arm64",
      targetRoot,
    });

    expect(manifest.artifacts.map(({ name }) => name)).toEqual([
      "rudder-process-host",
      "rudder-native",
      "rudder-update-helper",
      "rudder-cli",
      "rudder-mcp",
    ]);
    expect(manifest.artifacts.every(({ sha256, bytes, version }) =>
      /^[0-9a-f]{64}$/u.test(sha256) && bytes > 0 && version === "0.0.0-test")).toBe(true);

    await writeNativeArtifactManifest(manifestPath, manifest);
    await expect(verifyNativeArtifactManifest({
      manifestPath,
      expectedVersion: "0.0.0-test",
      expectedTarget: "aarch64-apple-darwin",
      expectedPlatform: "darwin",
      expectedArch: "arm64",
      targetRoot,
    })).resolves.toEqual(manifest);
  });

  it("fails closed for a mixed target identity or changed binary", async () => {
    const targetRoot = await makeTargetRoot();
    const manifestPath = path.join(targetRoot, "rudder-native-artifacts.json");
    const manifest = await createNativeArtifactManifest({
      version: "0.0.0-test",
      target: "aarch64-apple-darwin",
      platform: "darwin",
      arch: "arm64",
      targetRoot,
    });
    await writeNativeArtifactManifest(manifestPath, manifest);

    await expect(verifyNativeArtifactManifest({
      manifestPath,
      expectedVersion: "0.0.0-test",
      expectedTarget: "x86_64-apple-darwin",
      expectedPlatform: "darwin",
      expectedArch: "x64",
      targetRoot,
    })).rejects.toThrow(/target/iu);

    await writeFile(path.join(targetRoot, "rudder-cli"), "mixed-version-binary");
    await expect(verifyNativeArtifactManifest({
      manifestPath,
      expectedVersion: "0.0.0-test",
      expectedTarget: "aarch64-apple-darwin",
      expectedPlatform: "darwin",
      expectedArch: "arm64",
      targetRoot,
    })).rejects.toThrow(/hash or size/iu);
  });

  it("fails closed when CLI or MCP is missing", async () => {
    const targetRoot = await makeTargetRoot();
    const manifestPath = path.join(targetRoot, "rudder-native-artifacts.json");
    const manifest = await createNativeArtifactManifest({
      version: "0.0.0-test",
      target: "aarch64-apple-darwin",
      platform: "darwin",
      arch: "arm64",
      targetRoot,
    });
    await writeNativeArtifactManifest(manifestPath, manifest);
    await rm(path.join(targetRoot, "rudder-mcp"));

    await expect(verifyNativeArtifactManifest({
      manifestPath,
      expectedVersion: "0.0.0-test",
      expectedTarget: "aarch64-apple-darwin",
      expectedPlatform: "darwin",
      expectedArch: "arm64",
      targetRoot,
    })).rejects.toThrow(/rudder-mcp/iu);
  });
});
