import { build, type BuildOptions } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const cliRoot = fileURLToPath(new URL("../..", import.meta.url));

it("emits lazy commands that reach validation from the built CLI without starting a database", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "rudder-cli-lazy-package-"));
  try {
    const { default: config } = await import(pathToFileURL(path.join(cliRoot, "esbuild.config.mjs")).href) as {
      default: BuildOptions;
    };
    await build({ ...config, absWorkingDir: cliRoot, outdir: path.join(fixture, "dist") });
    await writeFile(path.join(fixture, "package.json"), await readFile(path.join(cliRoot, "package.json")));
    // Exercise the real emitted CLI modules. Workspace external dependencies
    // export TypeScript sources, so the child uses tsx only to resolve those.
    // Fresh npm-install acceptance separately verifies published dependencies.
    await symlink(path.join(cliRoot, "node_modules"), path.join(fixture, "node_modules"),
      process.platform === "win32" ? "junction" : "dir");
    const env = {
      ...process.env,
      RUDDER_HOME: path.join(fixture, "home"),
      RUDDER_CONFIG: path.join(fixture, "absent-config.json"),
      NO_COLOR: "1",
    };
    const cases = [
      {
        args: ["worktree", "init", "--name", "packaging-probe", "--seed-mode", "invalid-mode"],
        error: "Unsupported seed mode",
      },
      {
        args: ["db:backup", "--retention-days", "0", "--dir", path.join(fixture, "backups")],
        error: "Invalid retention days",
      },
    ];
    for (const { args, error } of cases) {
      const result = spawnSync(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, path.join(fixture, "dist/index.js"), ...args], {
        cwd: fixture, env, encoding: "utf8", timeout: 20_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain(error);
      expect(result.stdout + result.stderr).not.toContain("Cannot find module");
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
