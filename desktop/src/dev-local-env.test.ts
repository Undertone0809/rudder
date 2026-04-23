import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDevScriptEnvironment } from "../../scripts/dev-local-env.mjs";

function createTempRepoRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rudder-dev-env-"));
}

function writeRepoLocalFiles(repoRoot: string, input: { env?: string; config?: Record<string, unknown> }) {
  const rudderDir = path.join(repoRoot, ".rudder");
  fs.mkdirSync(rudderDir, { recursive: true });
  if (input.env !== undefined) {
    fs.writeFileSync(path.join(rudderDir, ".env"), input.env, "utf8");
  }
  if (input.config !== undefined) {
    fs.writeFileSync(path.join(rudderDir, "config.json"), `${JSON.stringify(input.config, null, 2)}\n`, "utf8");
  }
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveDevScriptEnvironment", () => {
  it("falls back to the shared dev profile when no repo-local worktree files exist", () => {
    const repoRoot = createTempRepoRoot();
    tempDirs.push(repoRoot);

    const resolved = resolveDevScriptEnvironment({
      repoRoot,
      baseEnv: {},
    });

    expect(resolved.localEnvName).toBe("dev");
    expect(resolved.env.RUDDER_INSTANCE_ID).toBe("dev");
    expect(resolved.env.PORT).toBe("3100");
    expect(resolved.env.RUDDER_EMBEDDED_POSTGRES_PORT).toBe("54329");
  });

  it("uses repo-local worktree instance identity and config-derived ports when present", () => {
    const repoRoot = createTempRepoRoot();
    tempDirs.push(repoRoot);

    writeRepoLocalFiles(repoRoot, {
      env: [
        "RUDDER_HOME=~/.rudder-worktrees",
        "RUDDER_INSTANCE_ID=rudder-staging",
        `RUDDER_CONFIG=${path.join(repoRoot, ".rudder", "config.json")}`,
      ].join("\n"),
      config: {
        server: { port: 4310 },
        database: { embeddedPostgresPort: 54429 },
      },
    });

    const resolved = resolveDevScriptEnvironment({
      repoRoot,
      baseEnv: { RUDDER_LOCAL_ENV: "dev" },
    });

    expect(resolved.localEnvName).toBe("dev");
    expect(resolved.env.RUDDER_HOME).toBe("~/.rudder-worktrees");
    expect(resolved.env.RUDDER_INSTANCE_ID).toBe("rudder-staging");
    expect(resolved.env.PORT).toBe("4310");
    expect(resolved.env.RUDDER_EMBEDDED_POSTGRES_PORT).toBe("54429");
  });

  it("preserves explicit process-level port overrides over repo-local config defaults", () => {
    const repoRoot = createTempRepoRoot();
    tempDirs.push(repoRoot);

    writeRepoLocalFiles(repoRoot, {
      env: "RUDDER_INSTANCE_ID=rudder-staging\n",
      config: {
        server: { port: 4310 },
        database: { embeddedPostgresPort: 54429 },
      },
    });

    const resolved = resolveDevScriptEnvironment({
      repoRoot,
      baseEnv: {
        PORT: "9999",
        RUDDER_EMBEDDED_POSTGRES_PORT: "54999",
      },
    });

    expect(resolved.env.RUDDER_INSTANCE_ID).toBe("rudder-staging");
    expect(resolved.env.PORT).toBe("9999");
    expect(resolved.env.RUDDER_EMBEDDED_POSTGRES_PORT).toBe("54999");
  });
});
