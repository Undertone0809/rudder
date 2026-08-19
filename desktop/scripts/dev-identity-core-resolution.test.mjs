import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptsDir, "..");
const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function runNode(extraArgs, source) {
  return spawnSync(
    process.execPath,
    [...extraArgs, "--input-type=module", "--eval", source],
    { cwd: desktopDir, encoding: "utf8" },
  );
}

describe("Desktop development identity-core resolution", () => {
  it("keeps source resolution for ordinary workspace development", () => {
    const result = runNode(
      [],
      "console.log(import.meta.resolve('@rudderhq/identity-core'))",
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/\/packages\/identity-core\/src\/index\.ts$/);
  });

  it("loads compiled identity-core code from the explicit Electron entry", () => {
    const build = spawnSync(
      pnpmExecutable,
      ["--filter", "@rudderhq/identity-core", "build"],
      { cwd: path.resolve(desktopDir, ".."), encoding: "utf8" },
    );
    expect(build.status, build.stderr || build.stdout).toBe(0);

    const result = runNode(
      [],
      "const mod = await import('@rudderhq/identity-core/electron'); console.log(mod.normalizeVerifiedEmail(' Test@Example.COM '))",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("test@example.com");
  });

  it("builds identity-core before launching the Desktop main process", () => {
    const manifest = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));

    expect(manifest.scripts.dev).toMatch(
      /^pnpm --filter @rudderhq\/identity-core build && .*stage:app-builder-toolchain && electron dist\/main\.js$/,
    );
  });
});
