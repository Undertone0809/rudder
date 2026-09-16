import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNativeWorkspaceFilesBinary } from "../services/workspace-files-native.js";

const { available, exists } = vi.hoisted(() => {
  const available = new Set<string>();
  return {
    available,
    exists: vi.fn((candidate: unknown) => available.has(String(candidate))),
  };
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
  it("finds the host release built by native:build without a debug build", () => {
    available.add(release);
    expect(resolveNativeWorkspaceFilesBinary()).toBe(release);
  });

  it("finds an explicitly targeted release for the current platform", () => {
    available.add(targetRelease);
    expect(resolveNativeWorkspaceFilesBinary()).toBe(targetRelease);
  });

  it("preserves the existing development debug preference", () => {
    available.add(debug);
    available.add(release);
    expect(resolveNativeWorkspaceFilesBinary()).toBe(debug);
  });

  it("never replaces a missing explicitly configured binary with another engine", () => {
    const configured = path.join(repoRoot, "missing-native");
    available.add(release);
    vi.stubEnv("RUDDER_NATIVE_WORKSPACE_FILES_PATH", configured);
    expect(resolveNativeWorkspaceFilesBinary()).toBe(configured);
    expect(exists).not.toHaveBeenCalled();
  });

  it("preserves explicit workspace, manifest, and global override precedence", () => {
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

  it("keeps a deterministic missing-binary path instead of enabling a fallback", () => {
    expect(resolveNativeWorkspaceFilesBinary()).toBe(debug);
  });
});
