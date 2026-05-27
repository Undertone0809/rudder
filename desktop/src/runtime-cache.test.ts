import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveExternalRuntimeServerEntrypoint,
  resolveSharedRudderHomeDir,
  sanitizeRuntimeCacheSegment,
} from "./runtime-cache.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-cache-test."));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime cache helpers", () => {
  it("normalizes runtime cache segments consistently with the CLI installer", () => {
    expect(sanitizeRuntimeCacheSegment("0.2.7-canary.3")).toBe("0.2.7-canary.3");
    expect(sanitizeRuntimeCacheSegment("@scope/pkg")).toBe("_40scope_2Fpkg");
    expect(sanitizeRuntimeCacheSegment("")).toBe("latest");
  });

  it("resolves RUDDER_HOME with shell-style home aliases", () => {
    expect(resolveSharedRudderHomeDir({ RUDDER_HOME: "~" }, "/Users/test")).toBe("/Users/test");
    expect(resolveSharedRudderHomeDir({ RUDDER_HOME: "~/rudder-data" }, "/Users/test")).toBe(
      "/Users/test/rudder-data",
    );
  });

  it("resolves a matching external server runtime entrypoint", async () => {
    const root = await makeTempRoot();
    const cacheDir = path.join(root, "runtimes", "0.2.7");
    const serverDir = path.join(cacheDir, "node_modules", "@rudderhq", "server");
    await mkdir(serverDir, { recursive: true });
    await writeFile(path.join(cacheDir, "package.json"), JSON.stringify({ private: true, type: "module" }), "utf8");
    await writeFile(
      path.join(cacheDir, "runtime.json"),
      JSON.stringify({ version: 1, packageName: "@rudderhq/server", packageVersion: "0.2.7" }),
      "utf8",
    );
    await writeFile(
      path.join(serverDir, "package.json"),
      JSON.stringify({ name: "@rudderhq/server", version: "0.2.7", main: "dist/index.js" }),
      "utf8",
    );
    await mkdir(path.join(serverDir, "dist"), { recursive: true });
    await writeFile(path.join(serverDir, "dist", "index.js"), "export {};\n", "utf8");

    const resolved = resolveExternalRuntimeServerEntrypoint({
      version: "0.2.7",
      env: { RUDDER_HOME: root },
    });

    expect(resolved?.cacheDir).toBe(cacheDir);
    expect(await realpath(resolved?.entrypoint ?? "")).toBe(
      await realpath(path.join(serverDir, "dist", "index.js")),
    );
  });

  it("rejects stale, malformed, or disabled runtime cache entries", async () => {
    const root = await makeTempRoot();
    const cacheDir = path.join(root, "runtimes", "0.2.7");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, "package.json"), JSON.stringify({ private: true }), "utf8");
    await writeFile(
      path.join(cacheDir, "runtime.json"),
      JSON.stringify({ version: 1, packageName: "@rudderhq/server", packageVersion: "0.2.6" }),
      "utf8",
    );

    expect(resolveExternalRuntimeServerEntrypoint({ version: "0.2.7", env: { RUDDER_HOME: root } })).toBeNull();
    expect(
      resolveExternalRuntimeServerEntrypoint({
        version: "0.2.7",
        env: { RUDDER_HOME: root, RUDDER_DESKTOP_DISABLE_EXTERNAL_RUNTIME: "1" },
      }),
    ).toBeNull();
  });

  it("rejects matching metadata when the installed server package version is stale", async () => {
    const root = await makeTempRoot();
    const cacheDir = path.join(root, "runtimes", "0.2.7");
    const serverDir = path.join(cacheDir, "node_modules", "@rudderhq", "server");
    await mkdir(serverDir, { recursive: true });
    await writeFile(path.join(cacheDir, "package.json"), JSON.stringify({ private: true, type: "module" }), "utf8");
    await writeFile(
      path.join(cacheDir, "runtime.json"),
      JSON.stringify({ version: 1, packageName: "@rudderhq/server", packageVersion: "0.2.7" }),
      "utf8",
    );
    await writeFile(
      path.join(serverDir, "package.json"),
      JSON.stringify({ name: "@rudderhq/server", version: "0.2.6", main: "dist/index.js" }),
      "utf8",
    );

    expect(resolveExternalRuntimeServerEntrypoint({ version: "0.2.7", env: { RUDDER_HOME: root } })).toBeNull();
  });
});
