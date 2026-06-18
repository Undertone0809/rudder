import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const auditScriptPath = path.join(scriptsDir, "architecture-audit.mjs");

function makeFixtureRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-architecture-audit-"));

  writeLines(path.join(repo, "ui", "src", "pages", "HugePage.tsx"), 8);
  writeLines(path.join(repo, "ui", "src", "pages", "HugePage.test.tsx"), 20);
  writeLines(path.join(repo, "server", "src", "routes", "huge.spec.ts"), 20);
  writeLines(path.join(repo, "packages", "plugins", "examples", "demo", "HugeExample.ts"), 20);
  writeLines(path.join(repo, "server", "dist", "Generated.ts"), 20);
  writeLines(path.join(repo, "node_modules", "pkg", "Huge.ts"), 20);
  writeLines(path.join(repo, "server", "src", "routes", "unbounded-list.ts"), 4, [
    "export function listEverything() {",
    "  return db.select().from(records);",
    "}",
    "",
  ]);

  return repo;
}

function writeLines(filePath, count, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = lines ?? Array.from({ length: count }, (_, index) => `export const line${index} = ${index};`);
  fs.writeFileSync(filePath, `${body.join("\n")}\n`);
}

function runAudit(root, args = []) {
  return spawnSync("node", [auditScriptPath, "--root", root, "--max-lines", "5", "--json", ...args], {
    encoding: "utf8",
  });
}

function writeBaseline(repo, oversizedFiles) {
  const baselinePath = path.join(repo, "architecture-audit-baseline.json");
  fs.writeFileSync(
    baselinePath,
    `${JSON.stringify({ maxLines: 5, oversizedFiles }, null, 2)}\n`,
  );
  return baselinePath;
}

test("architecture audit reports oversized production files and excludes non-production files", () => {
  const repo = makeFixtureRepo();

  try {
    const result = runAudit(repo);
    assert.equal(result.status, 0, result.stderr);

    const output = JSON.parse(result.stdout);
    assert.deepEqual(
      output.oversizedFiles.map((entry) => entry.path),
      ["ui/src/pages/HugePage.tsx"],
    );
    assert.equal(output.oversizedFiles[0].lines, 8);
  } finally {
    fs.rmSync(repo, { force: true, recursive: true });
  }
});

test("architecture audit keeps list-like data-volume findings advisory", () => {
  const repo = makeFixtureRepo();

  try {
    const result = runAudit(repo);
    assert.equal(result.status, 0, result.stderr);

    const output = JSON.parse(result.stdout);
    assert.deepEqual(
      output.advisoryListLikeFiles.map((entry) => entry.path),
      ["server/src/routes/unbounded-list.ts"],
    );
  } finally {
    fs.rmSync(repo, { force: true, recursive: true });
  }
});

test("architecture audit fails ratchet checks for new or growing oversized files", () => {
  const repo = makeFixtureRepo();

  try {
    writeLines(path.join(repo, "server", "src", "routes", "NewHugeRoute.ts"), 10, [
      "export function route() {",
      "  return [",
      "    1,",
      "    2,",
      "    3,",
      "    4,",
      "    5,",
      "    6,",
      "  ];",
      "}",
    ]);
    const baselinePath = writeBaseline(repo, [
      { path: "ui/src/pages/HugePage.tsx", lines: 7 },
    ]);

    const result = runAudit(repo, ["--baseline", baselinePath, "--fail-on-regression"]);
    assert.equal(result.status, 1);

    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.regressions, [
      {
        path: "server/src/routes/NewHugeRoute.ts",
        lines: 10,
        baselineLines: null,
        reason: "new oversized file",
      },
      {
        path: "ui/src/pages/HugePage.tsx",
        lines: 8,
        baselineLines: 7,
        reason: "oversized file grew past baseline",
      },
    ]);
  } finally {
    fs.rmSync(repo, { force: true, recursive: true });
  }
});

test("architecture audit accepts oversized files that stay at or below baseline", () => {
  const repo = makeFixtureRepo();

  try {
    const baselinePath = writeBaseline(repo, [
      { path: "ui/src/pages/HugePage.tsx", lines: 8 },
    ]);

    const result = runAudit(repo, ["--baseline", baselinePath, "--fail-on-regression"]);
    assert.equal(result.status, 0, result.stderr);

    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.regressions, []);
  } finally {
    fs.rmSync(repo, { force: true, recursive: true });
  }
});
