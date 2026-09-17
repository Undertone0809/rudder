import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNativeWorkspaceFilesBinary } from "../services/workspace-files-native.js";

const { available, exists } = vi.hoisted(() => {
  const available = new Set<string>();
  return { available, exists: vi.fn((candidate: unknown) => available.has(String(candidate))) };
});

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: exists,
}));

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binary = process.platform === "win32" ? "rudder-native.exe" : "rudder-native";
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const target = process.platform === "darwin"
  ? `${arch}-apple-darwin`
  : process.platform === "win32"
    ? `${arch}-pc-windows-msvc`
    : `${arch}-unknown-linux-gnu`;
const debug = path.join(repoRoot, "native", "target", "debug", binary);
const release = path.join(repoRoot, "native", "target", "release", binary);
const targetRelease = path.join(repoRoot, "native", "target", target, "release", binary);

beforeEach(() => {
  available.clear();
  exists.mockClear();
  for (const name of [
    "RUDDER_NATIVE_WORKSPACE_FILES_PATH",
    "RUDDER_NATIVE_WORKSPACE_MANIFEST_PATH",
    "RUDDER_NATIVE_PATH",
    "RUDDER_DESKTOP_RESOURCES_PATH",
  ]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("native workspace binary discovery", () => {
  it("finds the host release without a debug artifact", () => {
    available.add(release);
    expect(resolveNativeWorkspaceFilesBinary()).toBe(release);
  });

  it("finds the target-specific release without a host release", () => {
    available.add(targetRelease);
    expect(resolveNativeWorkspaceFilesBinary()).toBe(targetRelease);
  });

  it("preserves debug precedence", () => {
    available.add(debug);
    available.add(release);
    available.add(targetRelease);
    expect(resolveNativeWorkspaceFilesBinary()).toBe(debug);
  });

  it("preserves workspace, manifest, and global explicit override precedence", () => {
    const global = path.join(repoRoot, "global-native");
    const manifest = path.join(repoRoot, "manifest-native");
    const workspace = path.join(repoRoot, "workspace-native");
    vi.stubEnv("RUDDER_NATIVE_PATH", global);
    expect(resolveNativeWorkspaceFilesBinary()).toBe(global);
    vi.stubEnv("RUDDER_NATIVE_WORKSPACE_MANIFEST_PATH", manifest);
    expect(resolveNativeWorkspaceFilesBinary()).toBe(manifest);
    vi.stubEnv("RUDDER_NATIVE_WORKSPACE_FILES_PATH", workspace);
    expect(resolveNativeWorkspaceFilesBinary()).toBe(workspace);
  });

  it("does not replace a missing explicit workspace path", () => {
    const configured = path.join(repoRoot, "missing-native");
    available.add(release);
    vi.stubEnv("RUDDER_NATIVE_WORKSPACE_FILES_PATH", configured);
    expect(resolveNativeWorkspaceFilesBinary()).toBe(configured);
    expect(exists).not.toHaveBeenCalled();
  });

  it("resolves packaged Desktop resources", () => {
    const resources = path.join(repoRoot, "synthetic-resources");
    const packaged = path.join(resources, "native", target, binary);
    vi.stubEnv("RUDDER_DESKTOP_RESOURCES_PATH", resources);
    available.add(packaged);
    expect(resolveNativeWorkspaceFilesBinary()).toBe(packaged);
  });

  it("preserves the staged native distribution when release candidates also exist", () => {
    const staged = path.join(repoRoot, "native", target, binary);
    available.add(release);
    available.add(targetRelease);
    available.add(staged);
    expect(resolveNativeWorkspaceFilesBinary()).toBe(staged);
  });

  it("resolves the staged native distribution", () => {
    const staged = path.join(repoRoot, "native", target, binary);
    available.add(staged);
    expect(resolveNativeWorkspaceFilesBinary()).toBe(staged);
  });

  it("preserves packaged Desktop resources when release candidates also exist", () => {
    const resources = path.join(repoRoot, "synthetic-resources");
    const packaged = path.join(resources, "native", target, binary);
    vi.stubEnv("RUDDER_DESKTOP_RESOURCES_PATH", resources);
    available.add(release);
    available.add(targetRelease);
    available.add(packaged);
    expect(resolveNativeWorkspaceFilesBinary()).toBe(packaged);
  });

  it("returns a deterministic debug path when no binary is available", () => {
    expect(resolveNativeWorkspaceFilesBinary()).toBe(debug);
  });
});
