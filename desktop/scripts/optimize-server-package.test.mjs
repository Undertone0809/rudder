import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  optimizeServerPackage,
  stripPackageTypeMetadata,
} from "./optimize-server-package.mjs";

const tempRoots = [];

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function linkDir(target, linkPath) {
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function createStorePackage(serverPackageDir, storeName, manifest, files = {}) {
  const packageRoot = path.join(
    serverPackageDir,
    "node_modules",
    ".pnpm",
    storeName,
    "node_modules",
    ...manifest.name.split("/"),
  );
  mkdirSync(packageRoot, { recursive: true });
  writeJson(path.join(packageRoot, "package.json"), manifest);
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(packageRoot, relativePath);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content);
  }
  return packageRoot;
}

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "rudder-optimize-package-"));
  tempRoots.push(root);
  const serverPackageDir = path.join(root, "server-package");
  const nodeModulesDir = path.join(serverPackageDir, "node_modules");
  mkdirSync(nodeModulesDir, { recursive: true });
  writeJson(path.join(serverPackageDir, "package.json"), {
    name: "@rudderhq/server",
    version: "1.0.0",
    dependencies: {
      "@rudderhq/workspace": "1.0.0",
      "gpt-tokenizer": "1.0.0",
      "runtime-root": "1.0.0",
    },
  });

  const runtimeRoot = createStorePackage(serverPackageDir, "runtime-root@1.0.0", {
    name: "runtime-root",
    version: "1.0.0",
    dependencies: {
      "nested-runtime": "1.0.0",
      "runtime-leaf": "1.0.0",
    },
    optionalDependencies: {
      "@embedded-postgres/darwin-arm64": "18.4.0",
      "optional-runtime": "1.0.0",
    },
    peerDependencies: {
      "peer-runtime": "*",
      vite: "*",
    },
    peerDependenciesMeta: {
      "peer-runtime": { optional: true },
      vite: { optional: true },
    },
  });
  const runtimeLeaf = createStorePackage(serverPackageDir, "runtime-leaf@1.0.0", {
    name: "runtime-leaf",
    version: "1.0.0",
    main: "index.js",
    types: "index.d.ts",
    exports: {
      ".": {
        types: "./index.d.ts",
        default: "./index.js",
      },
    },
  }, {
    "index.d.ts": "export declare const value: string;\n",
    "index.d.mts": "export declare const value: string;\n",
    "index.js": "exports.value = 'runtime';\n//# sourceMappingURL=index.js.map\n",
    "index.js.map": "{}\n",
    "tests/runtime.test.js": "throw new Error('must not ship');\n",
  });
  const nestedRuntime = path.join(runtimeRoot, "node_modules", "nested-runtime");
  mkdirSync(nestedRuntime, { recursive: true });
  writeJson(path.join(nestedRuntime, "package.json"), {
    name: "nested-runtime",
    version: "1.0.0",
    main: "index.js",
    dependencies: {
      "runtime-leaf": "1.0.0",
    },
  });
  writeFileSync(path.join(nestedRuntime, "index.js"), "exports.nested = true;\n");
  const optionalRuntime = createStorePackage(serverPackageDir, "optional-runtime@1.0.0", {
    name: "optional-runtime",
    version: "1.0.0",
    main: "index.js",
  }, {
    "index.js": "exports.optional = true;\n",
  });
  const peerRuntime = createStorePackage(serverPackageDir, "peer-runtime@1.0.0", {
    name: "peer-runtime",
    version: "1.0.0",
    main: "index.js",
  }, {
    "index.js": "exports.peer = true;\n",
  });
  const embeddedPostgres = createStorePackage(serverPackageDir, "embedded-postgres-platform@18.4.0", {
    name: "@embedded-postgres/darwin-arm64",
    version: "18.4.0",
    main: "index.js",
  }, {
    "index.js": "exports.binary = true;\n",
  });
  const vite = createStorePackage(serverPackageDir, "vite@7.0.0", {
    name: "vite",
    version: "7.0.0",
    main: "index.js",
  }, {
    "index.js": "exports.devOnly = true;\n",
  });
  const workspace = createStorePackage(serverPackageDir, "rudder-workspace@1.0.0", {
    name: "@rudderhq/workspace",
    version: "1.0.0",
    main: "./dist/index.js",
  }, {
    "dist/index.js": "exports.workspace = true;\n",
    "src/index.ts": "export const workspace = true;\n",
  });
  const tokenizer = createStorePackage(serverPackageDir, "gpt-tokenizer@1.0.0", {
    name: "gpt-tokenizer",
    version: "1.0.0",
    license: "MIT",
  }, {
    "LICENSE": "MIT\n",
    "cjs/encoding/o200k_base.js": [
      "exports.encode = (value) => Array.from(Buffer.from(value));",
      "exports.decode = (tokens) => Buffer.from(tokens).toString();",
      "",
    ].join("\n"),
    "src/unused.ts": "export const unused = true;\n",
  });

  const runtimeNodeModules = path.dirname(runtimeRoot);
  linkDir(runtimeLeaf, path.join(runtimeNodeModules, "runtime-leaf"));
  linkDir(optionalRuntime, path.join(runtimeNodeModules, "optional-runtime"));
  linkDir(peerRuntime, path.join(runtimeNodeModules, "peer-runtime"));
  linkDir(embeddedPostgres, path.join(runtimeNodeModules, "@embedded-postgres", "darwin-arm64"));
  linkDir(vite, path.join(runtimeNodeModules, "vite"));
  symlinkSync("index.d.ts", path.join(runtimeLeaf, "index.ts"));

  linkDir(runtimeRoot, path.join(nodeModulesDir, "runtime-root"));
  linkDir(workspace, path.join(nodeModulesDir, "@rudderhq", "workspace"));
  linkDir(tokenizer, path.join(nodeModulesDir, "gpt-tokenizer"));

  return {
    embeddedPostgres,
    nestedRuntime,
    runtimeLeaf,
    peerRuntime,
    serverPackageDir,
    tokenizer,
    vite,
    workspace,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Desktop production package manifest optimizer", () => {
  it("breaks hardlinks before stripping deployed type metadata", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rudder-optimize-manifest-"));
    tempRoots.push(root);
    const sourceManifest = path.join(root, "source-package.json");
    const deployedManifest = path.join(root, "deployed-package.json");
    const manifest = {
      name: "postgres",
      version: "3.4.8",
      types: "types/index.d.ts",
    };
    writeJson(sourceManifest, manifest);
    linkSync(sourceManifest, deployedManifest);

    await stripPackageTypeMetadata(deployedManifest);

    expect(JSON.parse(readFileSync(sourceManifest, "utf8"))).toEqual(manifest);
    expect(JSON.parse(readFileSync(deployedManifest, "utf8")).types).toBeUndefined();
  });
});

describe("Desktop production server package optimizer", () => {
  it("keeps runtime dependencies while pruning optional peer tooling and duplicate PostgreSQL", async () => {
    const fixture = createFixture();

    const manifest = await optimizeServerPackage({
      arch: "arm64",
      bundledPostgres: true,
      platform: "darwin",
      serverPackageDir: fixture.serverPackageDir,
    });
    expect(existsSync(fixture.vite)).toBe(false);
    expect(existsSync(fixture.embeddedPostgres)).toBe(false);
    expect(existsSync(fixture.runtimeLeaf)).toBe(true);
    expect(existsSync(fixture.nestedRuntime)).toBe(true);
    expect(existsSync(fixture.peerRuntime)).toBe(true);
    expect(existsSync(path.join(fixture.runtimeLeaf, "index.js"))).toBe(true);
    expect(existsSync(path.join(fixture.runtimeLeaf, "index.d.ts"))).toBe(false);
    expect(existsSync(path.join(fixture.runtimeLeaf, "index.d.mts"))).toBe(false);
    expect(existsSync(path.join(fixture.runtimeLeaf, "index.ts"))).toBe(false);
    expect(existsSync(path.join(fixture.runtimeLeaf, "index.js.map"))).toBe(false);
    expect(existsSync(path.join(fixture.runtimeLeaf, "tests"))).toBe(false);
    const runtimeLeafManifest = JSON.parse(
      readFileSync(path.join(fixture.runtimeLeaf, "package.json"), "utf8"),
    );
    expect(runtimeLeafManifest.types).toBeUndefined();
    expect(runtimeLeafManifest.exports["."].types).toBeUndefined();
    expect(runtimeLeafManifest.exports["."].default).toBe("./index.js");
    expect(existsSync(path.join(fixture.workspace, "dist", "index.js"))).toBe(true);
    expect(existsSync(path.join(fixture.workspace, "src"))).toBe(false);
    expect(manifest.omittedPackages).toContain("@embedded-postgres/darwin-arm64");
    expect(manifest.removedVirtualStoreEntries).toEqual(expect.arrayContaining([
      "embedded-postgres-platform@18.4.0",
      "vite@7.0.0",
    ]));
    expect(manifest.postPruneBrokenSymlinks).toBe(1);

    const requireFromPackage = createRequire(path.join(fixture.serverPackageDir, "package.json"));
    const compactTokenizer = requireFromPackage("gpt-tokenizer/encoding/o200k_base");
    const tokens = compactTokenizer.encode("Rudder 世界");
    expect(compactTokenizer.decode(tokens)).toBe("Rudder 世界");
    expect(existsSync(path.join(fixture.tokenizer, "src"))).toBe(false);
    expect(readFileSync(
      path.join(fixture.serverPackageDir, ".rudder-production-package.json"),
      "utf8",
    )).toContain('"status": "optimized"');
  });

  it("retains embedded PostgreSQL when no official portable payload is bundled", async () => {
    const fixture = createFixture();

    const manifest = await optimizeServerPackage({
      arch: "arm64",
      bundledPostgres: false,
      platform: "darwin",
      serverPackageDir: fixture.serverPackageDir,
    });

    expect(existsSync(fixture.embeddedPostgres)).toBe(true);
    expect(manifest.omittedPackages).toEqual([]);
  });

  it("removes the build-host PostgreSQL package when the portable target uses another arch", async () => {
    const fixture = createFixture();

    const manifest = await optimizeServerPackage({
      arch: "x64",
      bundledPostgres: true,
      platform: "darwin",
      serverPackageDir: fixture.serverPackageDir,
    });

    expect(existsSync(fixture.embeddedPostgres)).toBe(false);
    expect(manifest.omittedPackages).toContain("@embedded-postgres/darwin-arm64");
    expect(manifest.omittedPackages).toContain("@embedded-postgres/darwin-x64");
  });
});
