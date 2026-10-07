import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX_BINARY = path.join(REPO_ROOT, "server/node_modules/.bin/tsx");

test("existing-server setup refuses a symlinked E2E home before writing stubs", async () => {
  test.skip(process.platform === "win32", "Creating directory symlinks may require elevated Windows privileges.");

  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "rudder-e2e-home-symlink-"));
  const target = path.join(fixtureRoot, "outside-target");
  const homeLink = path.join(fixtureRoot, "rudder-e2e-home-link");

  try {
    await mkdir(target);
    await symlink(target, homeLink, "dir");

    const result = spawnSync(
      TSX_BINARY,
      ["-e", 'import("./tests/e2e/support/existing-server-setup.ts").then((module) => module.default())'],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          RUDDER_E2E_HOME: homeLink,
          RUDDER_E2E_RUN_ID: "existing-server-home-symlink-negative",
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("symbolic link");
    await expect(lstat(path.join(target, "bin"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
