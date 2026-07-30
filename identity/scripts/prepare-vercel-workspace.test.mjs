import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDeploymentManifest,
  prepareVercelWorkspace,
} from "./prepare-vercel-workspace.mjs";

const sourceManifest = {
  name: "@rudderhq/identity-core",
  exports: { ".": "./src/index.ts" },
  publishConfig: {
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    },
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
  },
};

test("creates a Node-compatible deployment manifest from publishConfig", () => {
  const manifest = createDeploymentManifest(sourceManifest);

  assert.deepEqual(manifest.exports, {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js",
    },
  });
  assert.equal(manifest.main, "./dist/index.js");
  assert.equal(manifest.types, "./dist/index.d.ts");
  assert.deepEqual(sourceManifest.exports, { ".": "./src/index.ts" });
});

test("only rewrites the workspace manifest inside Vercel", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "rudder-vercel-workspace-"));
  const packagePath = path.join(directory, "package.json");
  await writeFile(packagePath, `${JSON.stringify(sourceManifest)}\n`);

  assert.equal(await prepareVercelWorkspace({ env: {}, packagePath }), false);
  assert.deepEqual(JSON.parse(await readFile(packagePath, "utf8")), sourceManifest);

  assert.equal(await prepareVercelWorkspace({ env: { VERCEL: "1" }, packagePath }), true);
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(manifest.exports["."].default, "./dist/index.js");
});
