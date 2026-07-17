import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "architecture-boundaries.mjs");

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-boundaries-"));
  write(root, "src/application.ts", 'import { publicValue } from "@fixture/domain-a";\nexport const value = publicValue;\n');
  write(root, "src/domain-a/index.ts", 'export { publicValue } from "./internal.js";\n');
  write(root, "src/domain-a/internal.ts", "export const publicValue = 1;\n");
  write(root, "src/domain-b/index.ts", "export const otherValue = 2;\n");
  writeConfig(root, {
    version: 1,
    scope: "declared-only",
    productionRoots: ["src"],
    aliases: {},
    domains: [domain("domain-a"), domain("domain-b")],
    observed: [{ area: "unmigrated", paths: ["src/legacy/**"], reason: "fixture observation" }],
  });
  return root;
}

function domain(id) {
  return {
    id,
    area: id,
    include: [`src/${id}/**/*.ts`],
    publicEntrypoints: [`src/${id}/index.ts`],
    specifierRoot: { prefix: `@fixture/${id}`, path: `src/${id}` },
    entrypoints: { [`@fixture/${id}`]: `src/${id}/index.ts` },
  };
}

function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeConfig(root, config) {
  write(root, "boundaries.json", `${JSON.stringify(config, null, 2)}\n`);
}

function run(root) {
  return spawnSync("node", [scriptPath, "--root", root, "--config", path.join(root, "boundaries.json"), "--json"], {
    encoding: "utf8",
  });
}

test("declared boundaries pass through public entrypoints and retain observed scope", () => {
  const root = makeFixture();
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.cycles, []);
    assert.deepEqual(output.facadeBypasses, []);
    assert.equal(output.scope, "declared-only");
    assert.equal(output.observed[0].area, "unmigrated");
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("declared boundaries reject package-subpath facade bypasses", () => {
  const root = makeFixture();
  try {
    write(root, "src/application.ts", 'import { publicValue } from "@fixture/domain-a/internal";\nexport const value = publicValue;\n');
    const result = run(root);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).facadeBypasses, [
      {
        domain: "domain-a",
        importedPath: "src/domain-a/internal.ts",
        source: "src/application.ts",
        specifier: "@fixture/domain-a/internal",
      },
    ]);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("declared boundaries reject static template-literal dynamic facade bypasses", () => {
  for (const expression of [
    "import(`@fixture/domain-a/internal`)",
    "require(`@fixture/domain-a/internal`)",
  ]) {
    const root = makeFixture();
    try {
      write(root, "src/application.ts", `export const load = () => ${expression};\n`);
      const result = run(root);
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).facadeBypasses[0]?.specifier, "@fixture/domain-a/internal");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  }
});

test("declared boundaries reject cross-domain cycles", () => {
  const root = makeFixture();
  try {
    write(root, "src/domain-a/internal.ts", 'import { otherValue } from "@fixture/domain-b";\nexport const publicValue = otherValue;\n');
    write(root, "src/domain-b/index.ts", 'import { publicValue } from "@fixture/domain-a";\nexport const otherValue = publicValue;\n');
    const result = run(root);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).cycles, [
      { cycle: "domain-a -> domain-b -> domain-a" },
    ]);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
