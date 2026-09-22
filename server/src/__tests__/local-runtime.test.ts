import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readLocalRuntimeDescriptor,
  removeLocalRuntimeDescriptorIfOwned,
  resolveEffectiveLocalEnvName,
  resolveLocalRuntimePaths,
  resolveManagedPostgresRuntimeKey,
  withRuntimeStartLock,
  writeLocalRuntimeDescriptor,
} from "../local-runtime.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("local runtime helpers", () => {
  it("does not steal a live startup lock after a long migration", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-startup-lock-"));
    process.env.RUDDER_HOME = tempHome;
    const { lockPath } = resolveLocalRuntimePaths("slow-migration");
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const owner = withRuntimeStartLock({ instanceId: "slow-migration" }, async () => {
      const payload = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      payload.createdAt = new Date(Date.now() - 60_000).toISOString();
      fs.writeFileSync(lockPath, JSON.stringify(payload));
      entered();
      await hold;
    });
    try {
      await ready;
      let secondEntered = false;
      await expect(withRuntimeStartLock({ instanceId: "slow-migration", timeoutMs: 0 }, async () => {
        secondEntered = true;
      })).rejects.toThrow("Timed out waiting");
      expect(secondEntered).toBe(false);
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    } finally {
      release();
      await owner;
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("fails closed while the startup lock owner is unreadable", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-startup-lock-"));
    process.env.RUDDER_HOME = tempHome;
    const { runtimeDir, lockPath } = resolveLocalRuntimePaths("partial-lock");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(lockPath, "");
    try {
      await expect(withRuntimeStartLock({ instanceId: "partial-lock", timeoutMs: 0 }, async () => {
        throw new Error("must not enter");
      })).rejects.toThrow("no readable owner");
      expect(fs.readFileSync(lockPath, "utf8")).toBe("");
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("serializes simultaneous starters recovering the same dead owner", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-startup-lock-"));
    process.env.RUDDER_HOME = tempHome;
    const { runtimeDir, lockPath } = resolveLocalRuntimePaths("dead-owner");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const deadPid = 2_147_483_647;
    expect(() => process.kill(deadPid, 0)).toThrow();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, ownerKind: "server", createdAt: new Date().toISOString() }));
    let active = 0;
    let peak = 0;
    let completed = 0;
    try {
      await Promise.all([1, 2].map(() => withRuntimeStartLock({ instanceId: "dead-owner", timeoutMs: 5_000 }, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        completed += 1;
      })));
      expect(peak).toBe(1);
      expect(completed).toBe(2);
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.existsSync(`${lockPath}.recovery`)).toBe(false);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it.each([true, false])("preserves abandoned recovery and refuses entry when start.lock exists=%s", async (hasStartLock) => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-startup-lock-"));
    process.env.RUDDER_HOME = tempHome;
    const { runtimeDir, lockPath } = resolveLocalRuntimePaths("abandoned-recovery");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const deadOwner = JSON.stringify({ pid: 2_147_483_647, ownerKind: "server", createdAt: new Date().toISOString() });
    if (hasStartLock) fs.writeFileSync(lockPath, deadOwner);
    fs.writeFileSync(`${lockPath}.recovery`, deadOwner);
    try {
      await expect(withRuntimeStartLock({ instanceId: "abandoned-recovery", timeoutMs: 0 }, async () => {
        throw new Error("must not enter");
      })).rejects.toThrow("Timed out waiting");
      if (hasStartLock) expect(fs.readFileSync(lockPath, "utf8")).toBe(deadOwner);
      else expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.readFileSync(`${lockPath}.recovery`, "utf8")).toBe(deadOwner);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("infers stable local env names from instance ids", () => {
    delete process.env.RUDDER_LOCAL_ENV;
    expect(resolveEffectiveLocalEnvName("default", undefined)).toBe("prod_local");
    expect(resolveEffectiveLocalEnvName("dev", undefined)).toBe("dev");
    expect(resolveEffectiveLocalEnvName("e2e", undefined)).toBe("e2e");
    expect(resolveEffectiveLocalEnvName("custom-instance", undefined)).toBeNull();
  });

  it("assigns a managed key only to the canonical shared PostgreSQL payload", () => {
    const homeDir = "/tmp/rudder-home";
    expect(resolveManagedPostgresRuntimeKey(
      path.join(homeDir, "runtime-payloads", "postgres-18.4", "darwin-arm64", "bin"),
      { homeDir, platform: "darwin", arch: "arm64" },
    )).toBe("postgres-18.4/darwin-arm64");
    expect(resolveManagedPostgresRuntimeKey("/opt/postgresql/18.4/bin", {
      homeDir,
      platform: "darwin",
      arch: "arm64",
    })).toBeNull();
  });

  it("round-trips runtime descriptors inside the instance runtime directory", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-local-runtime-"));
    process.env.RUDDER_HOME = tempHome;
    process.env.RUDDER_INSTANCE_ID = "dev";

    const descriptor = {
      instanceId: "dev",
      localEnv: "dev",
      pid: process.pid,
      listenPort: 3100,
      apiUrl: "http://127.0.0.1:3100",
      version: "0.1.0",
      ownerKind: "desktop" as const,
      startedAt: "2026-03-30T00:00:00.000Z",
      postgresBinDir: path.join(tempHome, "runtime-payloads", "postgres-18.4", "darwin-arm64", "bin"),
      postgresRuntimeKey: "postgres-18.4/darwin-arm64",
    };

    await writeLocalRuntimeDescriptor(descriptor);
    const paths = resolveLocalRuntimePaths("dev");
    expect(paths.descriptorPath).toBe(path.resolve(tempHome, "instances", "dev", "runtime", "server.json"));

    const loaded = await readLocalRuntimeDescriptor("dev");
    expect(loaded).toEqual(descriptor);

    await removeLocalRuntimeDescriptorIfOwned({ instanceId: "dev", pid: process.pid, apiUrl: descriptor.apiUrl });
    expect(await readLocalRuntimeDescriptor("dev")).toBeNull();
  });

  it("rejects malformed optional PostgreSQL descriptor fields without accepting unsafe cleanup metadata", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-local-runtime-invalid-pg-"));
    process.env.RUDDER_HOME = tempHome;
    const paths = resolveLocalRuntimePaths("dev");
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    fs.writeFileSync(paths.descriptorPath, JSON.stringify({
      instanceId: "dev",
      localEnv: "dev",
      pid: process.pid,
      listenPort: 3100,
      apiUrl: "http://127.0.0.1:3100",
      version: "0.1.0",
      ownerKind: "desktop",
      startedAt: "2026-03-30T00:00:00.000Z",
      postgresBinDir: 42,
      postgresRuntimeKey: false,
    }));

    const loaded = await readLocalRuntimeDescriptor("dev");
    expect(loaded).toMatchObject({
      instanceId: "dev",
      pid: process.pid,
    });
    expect(loaded).not.toHaveProperty("postgresBinDir");
    expect(loaded).not.toHaveProperty("postgresRuntimeKey");
  });
});
