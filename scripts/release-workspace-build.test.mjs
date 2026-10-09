import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootBuild = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).scripts.build;
const pnpmCli = path.join(path.dirname(createRequire(path.join(repoRoot, "desktop/package.json")).resolve("pnpm")), "bin/pnpm.cjs");
const fixtureRoots = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture({ build = rootBuild } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "rudder-workspace-build-"));
  fixtureRoots.push(root);
  function write(relative, content) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  write("package.json", JSON.stringify({ private: true, scripts: { build }, packageManager: "pnpm@9.15.4" }));
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n  - server\n  - ui\n  - desktop\n");
  // Actual pnpm scheduling and production orchestration run against disposable
  // package outputs. A second writer fails deterministically, even when the
  // machine happens to serialize the filesystem race from the release log.
  write("build-package.cjs", `
const fs = require('node:fs');
const path = require('node:path');
const name = require(path.join(process.cwd(), 'package.json')).name;
const root = process.env.BUILD_FIXTURE_ROOT;
const marker = path.join(root, name.replace('@rudderhq/', '') + '.built');
if (process.env.FAIL_PACKAGE === name) throw new Error('Requested package failure: ' + name);
fs.writeFileSync(marker, name, { flag: 'wx' });
fs.appendFileSync(path.join(root, 'events'), 'build:' + name + '\\n');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', name);
`);
  for (const [directory, name, dependencies] of [
    ["packages/shared", "shared", {}],
    ["packages/db", "db", { "@rudderhq/shared": "workspace:*" }],
    ["server", "server", { "@rudderhq/db": "workspace:*" }],
    ["ui", "ui", { "@rudderhq/shared": "workspace:*" }],
  ]) {
    const script = `${directory.startsWith("packages/") ? "../../" : "../"}build-package.cjs`;
    write(`${directory}/package.json`, JSON.stringify({
      name: `@rudderhq/${name}`, version: "1.0.0", dependencies,
      scripts: {
        build: `node ${script}`,
        ...(name === "server" ? { "prepare:ui-dist": "node ../scripts/prepare-server-ui-dist.mjs" } : {}),
      },
    }));
  }
  write("desktop/package.json", JSON.stringify({
    name: "@rudderhq/desktop", version: "1.0.0", type: "module",
    dependencies: { "@rudderhq/shared": "workspace:*" },
    scripts: { build: "node scripts/build.mjs" },
  }));
  for (const script of ["desktop/scripts/build.mjs", "scripts/prepare-server-ui-dist.mjs"]) {
    mkdirSync(path.dirname(path.join(root, script)), { recursive: true });
    copyFileSync(path.join(repoRoot, script), path.join(root, script));
  }
  const stageScript = `
import fs from 'node:fs';
import path from 'node:path';
const root = process.env.BUILD_FIXTURE_ROOT;
for (const name of ['shared', 'db', 'server', 'ui']) {
  if (!fs.existsSync(path.join(root, name + '.built'))) throw new Error('Staging before build: ' + name);
}
fs.appendFileSync(path.join(root, 'events'), 'stage:' + path.basename(process.argv[1]) + '\\n');
`;
  for (const name of ["stage-server", "stage-cli", "stage-native", "stage-app-builder-toolchain", "stage-app"]) {
    write(`desktop/scripts/${name}.mjs`, stageScript);
  }
  write("bin/tsc.cjs", "require('node:fs').appendFileSync(process.env.BUILD_FIXTURE_ROOT + '/events', 'stage:tsc\\n')");
  if (process.platform === "win32") {
    write("bin/tsc.cmd", `@"${process.execPath}" "%~dp0tsc.cjs" %*\r\n`);
    write("bin/pnpm.cmd", `@"${process.execPath}" "${pnpmCli}" %*\r\n`);
  } else {
    write("bin/tsc", `#!${process.execPath}\n${readFileSync(path.join(root, "bin/tsc.cjs"), "utf8")}`);
    // Executable fixture only, never a workspace compiler or package output.
    chmodSync(path.join(root, "bin/tsc"), 0o755);
    write("bin/pnpm", `#!/bin/sh\nexec "${process.execPath}" "${pnpmCli}" "$@"\n`);
    chmodSync(path.join(root, "bin/pnpm"), 0o755);
  }
  return root;
}

function run(root, args, extraEnv = {}) {
  return spawnSync(process.execPath, [pnpmCli, ...args], {
    cwd: root, encoding: "utf8", timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`,
      BUILD_FIXTURE_ROOT: root,
      ...extraEnv,
    },
  });
}

function events(root) {
  return readFileSync(path.join(root, "events"), "utf8").trim().split("\n");
}

describe("release workspace build ownership", () => {
  it("builds each workspace once before all Desktop staging under real pnpm scheduling", () => {
    const root = fixture();
    const result = run(root, ["build"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const recorded = events(root);
    expect(recorded.slice(0, 4).sort()).toEqual([
      "build:@rudderhq/db", "build:@rudderhq/server", "build:@rudderhq/shared", "build:@rudderhq/ui",
    ]);
    expect(recorded.slice(4)).toEqual([
      "stage:stage-server.mjs", "stage:stage-cli.mjs", "stage:stage-native.mjs",
      "stage:tsc", "stage:stage-app-builder-toolchain.mjs", "stage:stage-app.mjs",
    ]);
    expect(readFileSync(path.join(root, "server/ui-dist/index.html"), "utf8")).toBe("@rudderhq/ui");
  }, 30_000);

  it("detects the former recursive root command's duplicate workspace writer", () => {
    const root = fixture({ build: "pnpm -r build" });
    const result = run(root, ["build"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("EEXIST");
    expect(events(root)).not.toContain("stage:stage-server.mjs");
  }, 30_000);

  it("keeps a standalone Desktop build self-contained", () => {
    const root = fixture();
    const result = run(root, ["--filter", "@rudderhq/desktop", "build"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(events(root).filter((event) => event.startsWith("build:")).sort()).toEqual([
      "build:@rudderhq/db", "build:@rudderhq/server", "build:@rudderhq/shared", "build:@rudderhq/ui",
    ]);
    expect(events(root).at(-1)).toBe("stage:stage-app.mjs");
  }, 30_000);

  it("does not stage Desktop after a workspace build fails", () => {
    const root = fixture();
    const result = run(root, ["build"], { FAIL_PACKAGE: "@rudderhq/db" });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Requested package failure: @rudderhq/db");
    expect(events(root).some((event) => event.startsWith("stage:"))).toBe(false);
  }, 30_000);

  it("does not reuse stale UI output after the root UI build fails", () => {
    const root = fixture();
    for (const relative of ["ui/dist", "server/ui-dist"]) {
      mkdirSync(path.join(root, relative), { recursive: true });
      writeFileSync(path.join(root, relative, "index.html"), "stale UI");
    }
    const result = run(root, ["build"], { FAIL_PACKAGE: "@rudderhq/ui" });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Requested package failure: @rudderhq/ui");
    expect(events(root).some((event) => event.startsWith("stage:"))).toBe(false);
  }, 30_000);

  it("still builds UI and replaces stale assets for direct server preparation", () => {
    const root = fixture();
    mkdirSync(path.join(root, "server/ui-dist"), { recursive: true });
    writeFileSync(path.join(root, "server/ui-dist/stale.js"), "stale UI");
    const result = run(root, ["--filter", "@rudderhq/server", "prepare:ui-dist"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(events(root)).toEqual(["build:@rudderhq/ui"]);
    expect(readFileSync(path.join(root, "server/ui-dist/index.html"), "utf8")).toBe("@rudderhq/ui");
    expect(existsSync(path.join(root, "server/ui-dist/stale.js"))).toBe(false);
  }, 30_000);

  it("fails closed when workspace-built mode is missing its UI output", () => {
    const root = fixture();
    const result = run(root, ["--filter", "@rudderhq/desktop", "build", "--workspace-built"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("UI build output missing");
    expect(existsSync(path.join(root, "events"))).toBe(false);
  }, 30_000);

  it("rejects unknown Desktop build flags before invoking any build", () => {
    const root = fixture();
    const result = run(root, ["--filter", "@rudderhq/desktop", "build", "--workpace-built"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Unknown desktop build argument");
    expect(existsSync(path.join(root, "events"))).toBe(false);
  }, 30_000);
});
