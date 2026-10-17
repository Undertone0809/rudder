import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import afterPack from "./after-pack.mjs";
import { resolveComputerUsePackageTarget } from "./computer-use-package-target.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const roots = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "rudder-stage-app-identity-"));
  roots.push(root);
  const desktop = path.join(root, "desktop");
  const write = (name, contents) => {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof contents === "string" ? contents : JSON.stringify(contents));
  };
  for (const name of ["stage-app.mjs", "normalize-internal-package-manifest.mjs", "computer-use-package-target.mjs"]) {
    mkdirSync(path.join(desktop, "scripts"), { recursive: true });
    cpSync(path.join(scriptDir, name), path.join(desktop, "scripts", name));
  }
  write("desktop/package.json", { name: "@rudderhq/desktop", version: "1.0.0", type: "module" });
  write("desktop/dist/main.js", "export {};\n");
  mkdirSync(path.join(root, "releases"));
  const installed = (name, manifest = {}) => {
    const packageDir = `desktop/node_modules/${name}`;
    write(`${packageDir}/package.json`, { name, version: "1.0.0", main: "index.js", ...manifest });
    write(`${packageDir}/index.js`, "module.exports = {};\n");
    return packageDir;
  };
  const identity = installed("@rudderhq/identity-core", {
    type: "module",
    exports: { ".": "./src/index.ts", "./electron": "./dist/index.js" },
    publishConfig: {
      exports: { ".": { import: "./dist/index.js" }, "./electron": { import: "./dist/index.js" } },
    },
  });
  write(`${identity}/src/index.ts`, "throw new Error('workspace source must not ship');\n");
  write(`${identity}/dist/index.js`, "export const identityClient = 'compiled-client';\n");
  write(`${identity}/node_modules/dev-only/index.js`, "throw new Error('development dependency');\n");
  installed("@rudderhq/shared", { dependencies: { zod: "1.0.0" } });
  installed("zod");
  installed("@trycua/cua-driver");
  installed("@ubjs/core");
  installed("@ubjs/node");
  const target = resolveComputerUsePackageTarget(process.platform, process.arch);
  if (target) {
    const native = installed(target.driverPackage);
    for (const file of target.driverFiles) write(`${native}/${file}`, "native fixture\n");
  }
  return { root, desktop };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Desktop packaged Identity client", () => {
  it.each(["darwin", "linux", "win32"])("loads both compiled exports after staging and %s packaging", async (platform) => {
    const { root, desktop } = fixture();
    const stage = spawnSync(process.execPath, [path.join(desktop, "scripts/stage-app.mjs")], {
      cwd: root,
      env: { ...process.env, RUDDER_DESKTOP_TARGET_ARCH: process.arch },
      encoding: "utf8",
    });
    expect(stage.status, stage.stderr).toBe(0);
    const stagedManifest = JSON.parse(readFileSync(path.join(desktop, ".packaged/app/package.json"), "utf8"));
    expect(stagedManifest.dependencies["@rudderhq/identity-core"]).toBe("1.0.0");
    const appOutDir = path.join(root, "isolated-output");
    await afterPack({ appDir: desktop, packager: { projectDir: desktop }, appOutDir, electronPlatformName: platform });
    const appRoot = platform === "darwin"
      ? path.join(appOutDir, "Rudder.app/Contents/Resources/app")
      : path.join(appOutDir, "resources/app");
    const probePath = path.join(appRoot, "probe.mjs");
    writeFileSync(probePath, "import { identityClient as root } from '@rudderhq/identity-core'; import { identityClient as electron } from '@rudderhq/identity-core/electron'; if (root !== 'compiled-client' || root !== electron) process.exit(1); console.log(root);\n");
    // Remove the source packages before importing: hoisted workspace modules
    // must not hide a missing packaged dependency, as they did in dev checks.
    rmSync(path.join(desktop, "node_modules"), { recursive: true, force: true });
    const probe = spawnSync(process.execPath, [probePath], { cwd: appRoot, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } });
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout.trim()).toBe("compiled-client");
    const packagedIdentity = path.join(appRoot, "node_modules/@rudderhq/identity-core");
    expect(existsSync(path.join(packagedIdentity, "src"))).toBe(false);
    expect(existsSync(path.join(packagedIdentity, "node_modules"))).toBe(false);
  });

  it("fails staging immediately when compiled Identity output is absent", () => {
    const { root, desktop } = fixture();
    rmSync(path.join(desktop, "node_modules/@rudderhq/identity-core/dist"), { recursive: true });
    const result = spawnSync(process.execPath, [path.join(desktop, "scripts/stage-app.mjs")], {
      cwd: root, encoding: "utf8", env: { ...process.env, RUDDER_DESKTOP_TARGET_ARCH: process.arch },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("identity-core");
  });
});
