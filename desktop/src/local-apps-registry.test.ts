import { chmod, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LocalAppRegistry,
  computeLocalAppTrustFingerprint,
  type LocalAppDefinitionDraft,
} from "./local-apps-registry.js";
import { LocalAppRuntimeManager } from "./local-apps-runtime.js";

const draft = (cwd: string): LocalAppDefinitionDraft => ({
  title: "Fixture app",
  executable: process.execPath,
  argv: ["fixture.mjs"],
  cwd,
  inheritedEnvNames: ["NODE_ENV", "RUDDER_TEST_TOKEN"],
  readiness: { path: "/health", timeoutMs: 5_000 },
  openPath: "/app",
});

describe("Desktop Local App registry", () => {
  it("writes a versioned atomic mode-0600 registry and leaves no temporary file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-registry-"));
    const registryPath = path.join(root, "local-apps.json");
    const registry = new LocalAppRegistry({ registryPath, installationId: "install-a" });
    const discovered = await registry.prepareDefinition(draft(root));
    await registry.createDefinition({ ...discovered, approvedFingerprint: discovered.trustFingerprint });

    const raw = JSON.parse(await readFile(registryPath, "utf8")) as Record<string, unknown>;
    expect(raw).toMatchObject({ version: 1, installationId: "install-a" });
    expect((await stat(registryPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("recovers a corrupt registry without returning definitions or executing anything", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-corrupt-"));
    const registryPath = path.join(root, "local-apps.json");
    await writeFile(registryPath, "{ definitely not json", { mode: 0o644 });
    const registry = new LocalAppRegistry({ registryPath, installationId: "install-a" });

    await expect(registry.listDefinitions()).resolves.toEqual([]);
    expect((await readdir(root)).some((name) => name.startsWith("local-apps.json.corrupt-"))).toBe(true);
    expect((await stat(registryPath)).mode & 0o777).toBe(0o600);
  });

  it("quarantines an oversized persisted icon instead of returning it to the renderer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-icon-tamper-"));
    const registryPath = path.join(root, "local-apps.json");
    const registry = new LocalAppRegistry({ registryPath, installationId: "install-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    await registry.createDefinition(prepared);
    const state = JSON.parse(await readFile(registryPath, "utf8")) as {
      definitions: Array<{ iconDataUrl: string }>;
    };
    state.definitions[0].iconDataUrl = `data:image/png;base64,${"A".repeat(512 * 1024)}`;
    await writeFile(registryPath, JSON.stringify(state), { mode: 0o600 });

    const reloaded = new LocalAppRegistry({ registryPath, installationId: "install-a" });
    await expect(reloaded.listDefinitions()).resolves.toEqual([]);
    expect((await readdir(root)).some((name) => name.startsWith("local-apps.json.corrupt-"))).toBe(true);
  });

  it("quarantines a persisted SVG that bypasses safe icon discovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-icon-svg-tamper-"));
    const registryPath = path.join(root, "local-apps.json");
    const registry = new LocalAppRegistry({ registryPath, installationId: "install-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    await registry.createDefinition(prepared);
    const state = JSON.parse(await readFile(registryPath, "utf8")) as {
      definitions: Array<{ iconDataUrl: string }>;
    };
    state.definitions[0].iconDataUrl = `data:image/svg+xml;base64,${Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    ).toString("base64")}`;
    await writeFile(registryPath, JSON.stringify(state), { mode: 0o600 });

    const reloaded = new LocalAppRegistry({ registryPath, installationId: "install-a" });
    await expect(reloaded.listDefinitions()).resolves.toEqual([]);
    expect((await readdir(root)).some((name) => name.startsWith("local-apps.json.corrupt-"))).toBe(true);
  });

  it("round-trips a valid icon at the discovery size boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-icon-boundary-"));
    const registryPath = path.join(root, "local-apps.json");
    const registry = new LocalAppRegistry({ registryPath, installationId: "install-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    await registry.createDefinition(prepared);
    const state = JSON.parse(await readFile(registryPath, "utf8")) as {
      definitions: Array<{ iconDataUrl: string }>;
    };
    const png = Buffer.alloc(384 * 1024);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    state.definitions[0].iconDataUrl = `data:image/png;base64,${png.toString("base64")}`;
    await writeFile(registryPath, JSON.stringify(state), { mode: 0o600 });

    const reloaded = new LocalAppRegistry({ registryPath, installationId: "install-a" });
    await expect(reloaded.listDefinitions()).resolves.toMatchObject([{
      iconDataUrl: state.definitions[0].iconDataUrl,
    }]);
  });

  it("uses canonical cwd and invalidates approval when any trusted launch field changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-fingerprint-"));
    const actual = path.join(root, "actual");
    const alias = path.join(root, "alias");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(actual));
    await symlink(actual, alias);
    const canonical = await realpath(actual);
    const first = await computeLocalAppTrustFingerprint(draft(alias));
    const same = await computeLocalAppTrustFingerprint({ ...draft(canonical), inheritedEnvNames: ["RUDDER_TEST_TOKEN", "NODE_ENV"] });
    const changed = await computeLocalAppTrustFingerprint({ ...draft(actual), openPath: "/changed" });
    expect(first.fingerprint).toBe(same.fingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);

    const registryPath = path.join(root, "local-apps.json");
    const registry = new LocalAppRegistry({ registryPath, installationId: "install-a" });
    const created = await registry.createDefinition({ ...first.definition, approvedFingerprint: first.fingerprint });
    const updated = await registry.updateDefinition(created.id, { ...first.definition, openPath: "/changed" });
    expect(updated.approvedFingerprint).toBeNull();
    await expect(registry.requireApprovedDefinition(created.id)).rejects.toThrow("Review changes");
  });

  it("never exposes inherited environment values in renderer-facing definitions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-env-"));
    process.env.RUDDER_TEST_TOKEN = "do-not-expose";
    const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    await registry.createDefinition({ ...prepared, approvedFingerprint: prepared.trustFingerprint });
    const serialized = JSON.stringify(await registry.listDefinitions());
    expect(serialized).toContain("RUDDER_TEST_TOKEN");
    expect(serialized).not.toContain("do-not-expose");
    await chmod(path.join(root, "registry.json"), 0o600);
  });

  it("never treats a renderer-supplied approved fingerprint as native approval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-untrusted-approval-"));
    const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    const created = await registry.createDefinition({
      ...prepared,
      approvedFingerprint: prepared.trustFingerprint,
    });
    expect(created.approvedFingerprint).toBeNull();
    await expect(registry.requireApprovedDefinition(created.id)).rejects.toThrow("Review changes");
    await registry.approveDefinition(created.id, prepared.trustFingerprint);
    await expect(registry.requireApprovedDefinition(created.id)).resolves.toMatchObject({
      approvedFingerprint: prepared.trustFingerprint,
    });
  });

  it("persists three distinct stable opaque identities in renderer DTOs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-identities-"));
    const registryPath = path.join(root, "registry.json");
    const registry = new LocalAppRegistry({ registryPath, installationId: "desktop-installation-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    const created = await registry.createDefinition(prepared);
    expect(created.desktopInstallationId).toBe("desktop-installation-a");
    expect(created.localBindingId).toBe(created.id);
    expect(new Set([created.desktopInstallationId, created.appPublicId, created.localBindingId]).size).toBe(3);

    const updated = await registry.updateDefinition(created.id, { ...draft(root), openPath: "/changed" });
    const reloaded = new LocalAppRegistry({ registryPath, installationId: "desktop-installation-a" });
    const [persisted] = await reloaded.listDefinitions();
    expect(updated).toMatchObject({
      desktopInstallationId: created.desktopInstallationId,
      appPublicId: created.appPublicId,
      localBindingId: created.localBindingId,
    });
    expect(persisted).toMatchObject({
      desktopInstallationId: created.desktopInstallationId,
      appPublicId: created.appPublicId,
      localBindingId: created.localBindingId,
    });
  });

  it("does not let an old runtime generation clear or overwrite a newer descriptor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-runtime-generation-"));
    const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    const created = await registry.createDefinition(prepared);
    await registry.recordRuntimeDescriptor(created.id, {
      status: "stopping", pid: 101, pgid: 101, generation: "old", port: 31_001,
    });

    await expect(registry.recordRuntimeDescriptorIfGeneration(created.id, "old", {
      status: "running", pid: 202, pgid: 202, generation: "new", port: 31_002,
    })).resolves.toBe(true);
    await expect(registry.recordRuntimeDescriptorIfGeneration(created.id, "old", null)).resolves.toBe(false);
    await expect(registry.recordRuntimeDescriptorIfGeneration(created.id, "old", {
      status: "failed", pid: null, pgid: null, generation: "old",
    })).resolves.toBe(false);
    await expect(registry.recordRuntimeDescriptorIfMatch(created.id, {
      generation: "new",
      status: "starting",
    }, {
      status: "running", pid: 202, pgid: 202, generation: "new", port: 31_002,
    })).resolves.toBe(false);
    await expect(registry.getRuntimeDescriptor(created.id)).resolves.toMatchObject({
      status: "running", pid: 202, pgid: 202, generation: "new", port: 31_002,
    });
  });

  it("rejects non-positive runtime process identities before any liveness probe can use them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-runtime-identities-"));
    const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    const created = await registry.createDefinition(prepared);

    await expect(registry.recordRuntimeDescriptor(created.id, {
      status: "running", pid: -101, pgid: 101, generation: "invalid", port: 31_001,
    })).rejects.toThrow("Invalid Local App runtime descriptor");
    await expect(registry.recordRuntimeDescriptor(created.id, {
      status: "running", pid: 101, pgid: 0, generation: "invalid", port: 31_001,
    })).rejects.toThrow("Invalid Local App runtime descriptor");
    await expect(registry.recordRuntimeDescriptor(created.id, {
      status: "running", pid: 101, pgid: 1, generation: "invalid", port: 31_001,
    })).rejects.toThrow("Invalid Local App runtime descriptor");
    await expect(registry.recordRuntimeDescriptor(created.id, {
      status: "running", pid: 1, pgid: 101, generation: "invalid", port: 31_001,
    })).rejects.toThrow("Invalid Local App runtime descriptor");
    await expect(registry.recordRuntimeDescriptor(created.id, {
      status: "running", pid: Number.MAX_SAFE_INTEGER + 1, pgid: 101, generation: "invalid", port: 31_001,
    })).rejects.toThrow("Invalid Local App runtime descriptor");
    await expect(registry.recordRuntimeDescriptor(created.id, {
      status: "running", pid: 101, pgid: Number.MAX_SAFE_INTEGER + 1, generation: "invalid", port: 31_001,
    })).rejects.toThrow("Invalid Local App runtime descriptor");
  });

  it("recovers without execution when persisted trusted launch fields do not match their fingerprint", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-tampered-"));
    const registryPath = path.join(root, "registry.json");
    const registry = new LocalAppRegistry({ registryPath, installationId: "install-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    const created = await registry.createDefinition(prepared);
    await registry.approveDefinition(created.id, prepared.trustFingerprint);
    const state = JSON.parse(await readFile(registryPath, "utf8")) as { definitions: Array<{ openPath: string }> };
    state.definitions[0].openPath = "/tampered";
    await writeFile(registryPath, JSON.stringify(state), { mode: 0o600 });

    const reloaded = new LocalAppRegistry({ registryPath, installationId: "install-a" });
    await expect(reloaded.listDefinitions()).resolves.toEqual([]);
    expect((await readdir(root)).some((name) => name.startsWith("registry.json.corrupt-"))).toBe(true);
  });

  it("quarantines an unknown persisted runtime status without losing the definition or treating it as stopped", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-runtime-status-"));
    const registryPath = path.join(root, "registry.json");
    const registry = new LocalAppRegistry({ registryPath, installationId: "install-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    const created = await registry.createDefinition(prepared);
    await registry.approveDefinition(created.id, prepared.trustFingerprint);
    await registry.recordRuntimeDescriptor(created.id, {
      status: "running", pid: 77_701, pgid: 77_701, generation: "malformed-status", port: 31_701,
    });
    const state = JSON.parse(await readFile(registryPath, "utf8")) as {
      runtimeDescriptors: Record<string, { status: string }>;
    };
    state.runtimeDescriptors[created.id].status = "running ";
    await writeFile(registryPath, JSON.stringify(state), { mode: 0o600 });

    const reloaded = new LocalAppRegistry({ registryPath, installationId: "install-a" });
    await expect(reloaded.listDefinitions()).resolves.toHaveLength(1);
    await expect(reloaded.getRuntimeDescriptor(created.id)).resolves.toMatchObject({
      status: "orphaned_unverified",
      pid: 77_701,
      pgid: 77_701,
      port: 31_701,
    });
    expect((await readdir(root)).some((name) => name.startsWith("registry.json.corrupt-"))).toBe(true);

    const spawnWatchdog = vi.fn(() => { throw new Error("must not spawn"); });
    const killGroup = vi.fn();
    const manager = new LocalAppRuntimeManager({
      registry: reloaded,
      platform: "darwin",
      spawnWatchdog: spawnWatchdog as never,
      killGroup,
    });
    expect((await manager.status(created.id)).status).toBe("orphaned_unverified");
    await expect(manager.start(created.id)).rejects.toThrow("unverified");
    expect(spawnWatchdog).not.toHaveBeenCalled();
    expect(killGroup).not.toHaveBeenCalled();
  });

  it("rejects routes that URL parsing could reinterpret outside the attested loopback origin", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-route-"));
    await expect(computeLocalAppTrustFingerprint({ ...draft(root), openPath: "/\\example.com" }))
      .rejects.toThrow("open path");
    await expect(computeLocalAppTrustFingerprint({ ...draft(root), readiness: { path: "/health\nInjected", timeoutMs: 5_000 } }))
      .rejects.toThrow("readiness path");
  });
});
