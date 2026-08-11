import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const preloadUrl = pathToFileURL(fileURLToPath(
  new URL("./app-builder-next-compat.mjs", import.meta.url),
)).href;
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runChild(scriptPath, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd,
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preloadUrl}`].filter(Boolean).join(" "),
        RUDDER_APP_BUILDER_NEXT_COMPAT: "1",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolve(output);
      else reject(new Error(output || `compat child exited with ${signal ?? code}`));
    });
  });
}

describe("App Builder Next compatibility preload", () => {
  it("patches legacy webpack config without rewriting an existing next-env declaration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-next-compat-"));
    roots.push(root);
    const nextRoot = path.join(root, "node_modules", "next", "dist");
    const configPath = path.join(nextRoot, "server", "config.js");
    const declarationsPath = path.join(
      nextRoot,
      "lib",
      "typescript",
      "writeAppTypeDeclarations.js",
    );
    const scriptPath = path.join(root, "exercise.cjs");
    await Promise.all([
      mkdir(path.dirname(configPath), { recursive: true }),
      mkdir(path.dirname(declarationsPath), { recursive: true }),
    ]);
    await writeFile(configPath, [
      'exports.default = async () => ({ webpack(config) { config.userWebpack = true; return config; } });',
      "",
    ].join("\n"));
    await writeFile(declarationsPath, [
      'const fs = require("node:fs/promises");',
      'const path = require("node:path");',
      "exports.writeAppTypeDeclarations = async ({ baseDir }) => {",
      '  await fs.writeFile(path.join(baseDir, "next-env.d.ts"), "rewritten\\n");',
      "};",
      "",
    ].join("\n"));
    await writeFile(path.join(root, "next-env.d.ts"), "original\n");
    await writeFile(scriptPath, [
      'const fs = require("node:fs/promises");',
      'const configModule = require("./node_modules/next/dist/server/config.js");',
      'const declarations = require("./node_modules/next/dist/lib/typescript/writeAppTypeDeclarations.js");',
      "(async () => {",
      "  const config = await configModule.default();",
      "  const webpackConfig = await config.webpack({ externals: [] }, { isServer: true });",
      "  let externalResult = null;",
      '  webpackConfig.externals.at(-1)({ request: "node:fs" }, (_error, result) => { externalResult = result; });',
      "  await declarations.writeAppTypeDeclarations({ baseDir: process.cwd() });",
      '  process.stdout.write(JSON.stringify({ userWebpack: webpackConfig.userWebpack, externalResult, declaration: await fs.readFile("next-env.d.ts", "utf8") }));',
      "})().catch((error) => { console.error(error); process.exit(1); });",
      "",
    ].join("\n"));

    const result = JSON.parse(await runChild(scriptPath, root));
    expect(result).toEqual({
      userWebpack: true,
      externalResult: "commonjs node:fs",
      declaration: "original\n",
    });
  });

  it("allows Next to create next-env when an app does not have one", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-next-compat-"));
    roots.push(root);
    const declarationsPath = path.join(
      root,
      "node_modules",
      "next",
      "dist",
      "lib",
      "typescript",
      "writeAppTypeDeclarations.js",
    );
    const scriptPath = path.join(root, "exercise.cjs");
    await mkdir(path.dirname(declarationsPath), { recursive: true });
    await writeFile(declarationsPath, [
      'const fs = require("node:fs/promises");',
      'const path = require("node:path");',
      'exports.writeAppTypeDeclarations = async ({ baseDir }) => fs.writeFile(path.join(baseDir, "next-env.d.ts"), "created\\n");',
      "",
    ].join("\n"));
    await writeFile(scriptPath, [
      'const declarations = require("./node_modules/next/dist/lib/typescript/writeAppTypeDeclarations.js");',
      "declarations.writeAppTypeDeclarations({ baseDir: process.cwd() }).catch((error) => { console.error(error); process.exit(1); });",
      "",
    ].join("\n"));

    await runChild(scriptPath, root);
    expect(await readFile(path.join(root, "next-env.d.ts"), "utf8")).toBe("created\n");
  });
});
