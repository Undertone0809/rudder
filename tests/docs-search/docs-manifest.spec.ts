import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("passes the manifest-complete static docs acceptance verifier", async ({ baseURL }) => {
  const result = spawnSync(
    process.execPath,
    ["scripts/verify-docs-static-export.mjs", baseURL ?? "http://127.0.0.1:4179"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain("68 canonical routes");
  expect(result.stdout).toContain("active alias checks");
});
