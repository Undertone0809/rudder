import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeLangfuseEnvironmentName,
  readLocalRuntimeDescriptor,
  removeLocalRuntimeDescriptorIfOwned,
  resolveLangfuseEnvironmentName,
  resolveEffectiveLocalEnvName,
  resolveLocalRuntimePaths,
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

  it("normalizes Langfuse environments to stable stage labels", () => {
    expect(normalizeLangfuseEnvironmentName("local")).toBe("prod");
    expect(normalizeLangfuseEnvironmentName("default")).toBe("prod");
    expect(normalizeLangfuseEnvironmentName("prod_local")).toBe("prod");
    expect(normalizeLangfuseEnvironmentName("development")).toBe("dev");
    expect(normalizeLangfuseEnvironmentName("test")).toBe("e2e");
    expect(normalizeLangfuseEnvironmentName("staging")).toBe("staging");
    expect(resolveLangfuseEnvironmentName(undefined, "prod_local")).toBe("prod");
    expect(resolveLangfuseEnvironmentName(undefined, "dev")).toBe("dev");
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
    };

    await writeLocalRuntimeDescriptor(descriptor);
    const paths = resolveLocalRuntimePaths("dev");
    expect(paths.descriptorPath).toBe(path.resolve(tempHome, "instances", "dev", "runtime", "server.json"));

    const loaded = await readLocalRuntimeDescriptor("dev");
    expect(loaded).toEqual(descriptor);

    await removeLocalRuntimeDescriptorIfOwned({ instanceId: "dev", pid: process.pid, apiUrl: descriptor.apiUrl });
    expect(await readLocalRuntimeDescriptor("dev")).toBeNull();
  });
});
