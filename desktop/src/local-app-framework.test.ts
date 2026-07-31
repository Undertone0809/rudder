import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectLocalAppFramework,
  localAppRuntimeArguments,
  type LocalAppFramework,
} from "./local-app-framework.js";

async function project(
  dependency: string,
  command: string,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-framework-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: { dev: command },
    devDependencies: { [dependency]: "1.0.0" },
  }));
  return root;
}

describe("Local App framework launch profiles", () => {
  it.each<[LocalAppFramework, string, string]>([
    ["vite", "vite", "vite"],
    ["react-vite", "react", "vite"],
    ["vue-vite", "vue", "vite"],
    ["next", "next", "next dev"],
    ["vue-cli", "@vue/cli-service", "vue-cli-service serve"],
    ["react-scripts", "react-scripts", "react-scripts start"],
    ["astro", "astro", "astro dev"],
    ["sveltekit", "@sveltejs/kit", "vite dev"],
    ["nuxt", "nuxt", "nuxt dev"],
  ])("detects %s", async (expected, dependency, command) => {
    await expect(detectLocalAppFramework(
      await project(dependency, command),
      "dev",
    )).resolves.toBe(expected);
  });

  it("makes the Rudder port authoritative for Vite-family scripts", async () => {
    const root = await project("vite", "vite");
    await expect(localAppRuntimeArguments(root, "/usr/local/bin/npm", ["run", "dev"], 43_123)).resolves.toEqual([
      "run",
      "dev",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      "43123",
      "--strictPort",
    ]);
    await expect(localAppRuntimeArguments(root, "/usr/local/bin/pnpm", ["run", "dev"], 43_123)).resolves.toEqual([
      "run",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      "43123",
      "--strictPort",
    ]);
  });

  it("uses Next's hostname flag and preserves an existing package-run separator", async () => {
    const root = await project("next", "next dev");
    await expect(localAppRuntimeArguments(
      root,
      "/usr/local/bin/npm",
      ["run", "dev", "--", "--turbo"],
      43_123,
    )).resolves.toEqual([
      "run",
      "dev",
      "--",
      "--turbo",
      "--hostname",
      "127.0.0.1",
      "--port",
      "43123",
    ]);
  });

  it("leaves environment-driven and direct commands unchanged", async () => {
    const reactRoot = await project("react-scripts", "react-scripts start");
    await expect(localAppRuntimeArguments(reactRoot, "/usr/local/bin/npm", ["run", "dev"], 43_123))
      .resolves.toEqual(["run", "dev"]);
    await expect(localAppRuntimeArguments(reactRoot, process.execPath, ["server.mjs"], 43_123))
      .resolves.toEqual(["server.mjs"]);
  });

  it("does not rewrite custom scripts merely because the project depends on Vite", async () => {
    const root = await project("vite", "node custom-server.mjs");
    await expect(localAppRuntimeArguments(root, "/usr/local/bin/npm", ["run", "dev"], 43_123))
      .resolves.toEqual(["run", "dev"]);
  });

  it("does not rewrite direct executables whose arguments happen to contain run", async () => {
    const root = await project("vite", "vite");
    await expect(localAppRuntimeArguments(
      root,
      process.execPath,
      ["wrapper.mjs", "run", "dev"],
      43_123,
    )).resolves.toEqual(["wrapper.mjs", "run", "dev"]);
  });

  it.each(["pnpm", "yarn", "bun"])("forwards arguments directly through %s", async (manager) => {
    const root = await project("vite", "vite");
    await expect(localAppRuntimeArguments(root, `/usr/local/bin/${manager}`, ["run", "dev"], 43_123))
      .resolves.toEqual([
        "run",
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        "43123",
        "--strictPort",
      ]);
  });

  it("recognizes the realpathed Corepack pnpm entry", async () => {
    const root = await project("vite", "vite");
    await expect(localAppRuntimeArguments(
      root,
      "/usr/local/lib/node_modules/corepack/dist/pnpm.js",
      ["run", "dev"],
      43_123,
    )).resolves.toEqual([
      "run",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      "43123",
      "--strictPort",
    ]);
  });

  it.each([
    "vite && node custom-server.mjs",
    "vite | tee vite.log",
    "vite; node custom-server.mjs",
  ])("does not rewrite a compound package script: %s", async (command) => {
    const root = await project("vite", command);
    await expect(localAppRuntimeArguments(root, "/usr/local/bin/npm", ["run", "dev"], 43_123))
      .resolves.toEqual(["run", "dev"]);
  });
});
