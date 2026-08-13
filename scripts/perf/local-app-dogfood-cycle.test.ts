import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runPackagedLocalAppCycle } from "./local-app-dogfood-cycle.mjs";

const identityEnv = {
  RUDDER_DOGFOOD_PACKAGED: "1",
  RUDDER_DESKTOP_SMOKE_MODE: "packaged",
  RUDDER_DOGFOOD_PACKAGED_EXECUTABLE: "",
  RUDDER_LOCAL_APP_DOGFOOD_CYCLE_INDEX: "0",
  RUDDER_LOCAL_APP_DOGFOOD_SOURCE_SHA: "a".repeat(40),
  RUDDER_LOCAL_APP_DOGFOOD_ARTIFACT_SHA256: "b".repeat(64),
  RUDDER_LOCAL_APP_DOGFOOD_RUNTIME_ID: "macOS-arm64-packaged-Rudder-0.7.5",
};

async function executable(root: string, name: string, contents: string) {
  const file = path.join(root, name);
  await writeFile(file, contents, { mode: 0o700 });
  await chmod(file, 0o700);
  return file;
}

describe("packaged Local App dogfood cycle producer", () => {
  it("fails closed when packaged smoke does not prove the real lifecycle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-local-app-dogfood-cycle-"));
    const packagedExecutable = await executable(root, "Rudder", "#!/bin/sh\nexit 0\n");
    const smokeScript = await executable(root, "smoke.mjs", "#!/usr/bin/env node\nprocess.stdout.write('smoke completed\n');\n");
    const previous = { ...process.env };
    Object.assign(process.env, { ...identityEnv, RUDDER_DOGFOOD_PACKAGED_EXECUTABLE: packagedExecutable });
    try {
      await expect(runPackagedLocalAppCycle({ smokeScript, packagedExecutable, timeoutMs: 5_000 }))
        .rejects.toThrow(/packaged Local App smoke (failed|required real success markers)/iu);
    } finally {
      process.env = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
