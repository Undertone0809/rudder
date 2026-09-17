import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNativeEvidenceIndexBinary } from "../services/run-log-store.js";

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
  for (const name of ["RUDDER_NATIVE_EVIDENCE_INDEX_PATH", "RUDDER_DESKTOP_RESOURCES_PATH"]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("run-evidence native binary discovery", () => {
  it("finds the host release produced by native:build without a debug artifact", () => {
    available.add(release);
    expect(resolveNativeEvidenceIndexBinary()).toBe(release);
  });

  it("finds an explicitly targeted native release", () => {
    available.add(targetRelease);
    expect(resolveNativeEvidenceIndexBinary()).toBe(targetRelease);
  });

  it("preserves the existing debug preference", () => {
    available.add(debug);
    available.add(release);
    expect(resolveNativeEvidenceIndexBinary()).toBe(debug);
  });

  it("preserves the staged binary preference when release candidates also exist", () => {
    const staged = path.join(root, "native", target, binary);
    available.add(release);
    available.add(staged);
    expect(resolveNativeEvidenceIndexBinary()).toBe(staged);
  });

  it("preserves packaged Desktop resources when release candidates also exist", () => {
    const resources = path.join(root, "synthetic-resources");
    const packaged = path.join(resources, "native", target, binary);
    vi.stubEnv("RUDDER_DESKTOP_RESOURCES_PATH", resources);
    available.add(release);
    available.add(packaged);
    expect(resolveNativeEvidenceIndexBinary()).toBe(packaged);
  });

  it("preserves an explicit missing override without probing other candidates", () => {
    const override = path.join(root, "missing-run-evidence-native");
    vi.stubEnv("RUDDER_NATIVE_EVIDENCE_INDEX_PATH", override);
    available.add(release);
    expect(resolveNativeEvidenceIndexBinary()).toBe(override);
    expect(exists).not.toHaveBeenCalled();
  });

  it("retains a deterministic missing path rather than starting another runtime", () => {
    expect(resolveNativeEvidenceIndexBinary()).toBe(debug);
  });
});
