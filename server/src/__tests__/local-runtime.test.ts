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
