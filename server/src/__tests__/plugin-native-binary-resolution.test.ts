import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNativePluginArchiveBinary } from "../services/plugin-archive-native.js";

const { available, exists } = vi.hoisted(() => {
  const available = new Set<string>();
  return { available, exists: vi.fn((candidate: unknown) => available.has(String(candidate))) };
});

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: exists,
}));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binary = process.platform === "win32" ? "rudder-native.exe" : "rudder-native";
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const target = process.platform === "darwin"
  ? `${arch}-apple-darwin`
  : process.platform === "win32" ? `${arch}-pc-windows-msvc` : `${arch}-unknown-linux-gnu`;
const debug = path.join(root, "native", "target", "debug", binary);
const release = path.join(root, "native", "target", "release", binary);
const targetRelease = path.join(root, "native", "target", target, "release", binary);

beforeEach(() => {
  available.clear();
  exists.mockClear();
  for (const name of ["RUDDER_NATIVE_PLUGIN_ARCHIVE_PATH", "RUDDER_NATIVE_ARCHIVE_PATH", "RUDDER_DESKTOP_RESOURCES_PATH"]) {
    vi.stubEnv(name, "");
  }
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("Plugin archive native binary discovery", () => {
  it("finds the host release produced by native:build without a debug artifact", () => {
    available.add(release);
    expect(resolveNativePluginArchiveBinary()).toBe(release);
  });

  it("finds an explicitly targeted native release", () => {
    available.add(targetRelease);
    expect(resolveNativePluginArchiveBinary()).toBe(targetRelease);
  });

  it("preserves the existing debug preference", () => {
    available.add(debug);
    available.add(release);
    expect(resolveNativePluginArchiveBinary()).toBe(debug);
  });

  it("preserves the staged binary preference when release candidates also exist", () => {
    const staged = path.join(root, "native", target, binary);
    available.add(release);
    available.add(staged);
    expect(resolveNativePluginArchiveBinary()).toBe(staged);
  });

  it("preserves explicit Plugin path precedence without replacing a missing binary", () => {
    const plugin = path.join(root, "missing-plugin-native");
    vi.stubEnv("RUDDER_NATIVE_PLUGIN_ARCHIVE_PATH", plugin);
    vi.stubEnv("RUDDER_NATIVE_ARCHIVE_PATH", path.join(root, "archive-native"));
    available.add(release);
    expect(resolveNativePluginArchiveBinary()).toBe(plugin);
    expect(exists).not.toHaveBeenCalled();
  });

  it("preserves the explicit archive override", () => {
    const archive = path.join(root, "explicit-archive-native");
    vi.stubEnv("RUDDER_NATIVE_ARCHIVE_PATH", archive);
    expect(resolveNativePluginArchiveBinary()).toBe(archive);
    expect(exists).not.toHaveBeenCalled();
  });

  it("still resolves packaged Desktop resources", () => {
    const resources = path.join(root, "synthetic-resources");
    const packaged = path.join(resources, "native", target, binary);
    vi.stubEnv("RUDDER_DESKTOP_RESOURCES_PATH", resources);
    available.add(packaged);
    expect(resolveNativePluginArchiveBinary()).toBe(packaged);
  });

  it("preserves packaged Desktop resources when release candidates also exist", () => {
    const resources = path.join(root, "synthetic-resources");
    const packaged = path.join(resources, "native", target, binary);
    vi.stubEnv("RUDDER_DESKTOP_RESOURCES_PATH", resources);
    available.add(release);
    available.add(packaged);
    expect(resolveNativePluginArchiveBinary()).toBe(packaged);
  });

  it("still resolves the staged native distribution", () => {
    const staged = path.join(root, "native", target, binary);
    available.add(staged);
    expect(resolveNativePluginArchiveBinary()).toBe(staged);
  });

  it("retains a deterministic missing path rather than starting another runtime", () => {
    expect(resolveNativePluginArchiveBinary()).toBe(debug);
  });
});
