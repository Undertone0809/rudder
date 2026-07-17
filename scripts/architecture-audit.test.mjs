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

function writeBaseline(repo, oversizedFiles, { addMetadata = true } = {}) {
  const baselinePath = path.join(repo, "architecture-audit-baseline.json");
  const entries = addMetadata
    ? oversizedFiles.map((entry) => ({
        owner: "fixture-owner",
        rationale: "fixture debt retained for ratchet coverage",
        target: "reduce below the fixture threshold",
        expiry: "2999-12-31",
        ...entry,
      }))
    : oversizedFiles;
  fs.writeFileSync(
    baselinePath,
    `${JSON.stringify({ maxLines: 5, oversizedFiles: entries }, null, 2)}\n`,
  );
  return baselinePath;
}

function runGit(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commitFixture(repo, message) {
  runGit(repo, ["add", "."]);
  runGit(repo, [
    "-c",
    "user.name=Architecture Audit",
    "-c",
    "user.email=architecture-audit@example.test",
    "commit",
    "-m",
    message,
  ]);
  return runGit(repo, ["rev-parse", "HEAD"]);
}

function initializeGitFixture(repo) {
  runGit(repo, ["init", "--quiet"]);
  return commitFixture(repo, "fixture baseline");
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

test("architecture audit rejects missing and expired debt exception metadata", () => {
  const repo = makeFixtureRepo();

  try {
    const baselinePath = writeBaseline(
      repo,
      [
        {
          path: "ui/src/pages/HugePage.tsx",
          lines: 8,
          owner: "",
          rationale: "",
          target: "",
          expiry: "2000-01-01",
        },
      ],
      { addMetadata: false },
    );

    const result = runAudit(repo, ["--baseline", baselinePath, "--fail-on-regression"]);
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.governanceViolations, [
      {
        path: "ui/src/pages/HugePage.tsx",
        reason: "oversized debt exception expired on 2000-01-01",
      },
      {
        path: "ui/src/pages/HugePage.tsx",
        reason: "oversized debt exception is missing owner",
      },
      {
        path: "ui/src/pages/HugePage.tsx",
        reason: "oversized debt exception is missing rationale",
      },
      {
        path: "ui/src/pages/HugePage.tsx",
        reason: "oversized debt exception is missing target",
      },
    ]);
  } finally {
    fs.rmSync(repo, { force: true, recursive: true });
  }
});

test("architecture audit requires an exception for every current oversized file", () => {
  const repo = makeFixtureRepo();

  try {
    const baselinePath = writeBaseline(repo, []);
    const result = runAudit(repo, ["--baseline", baselinePath, "--fail-on-regression"]);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).governanceViolations, [
      {
        path: "ui/src/pages/HugePage.tsx",
        reason: "oversized production file is missing a debt exception",
      },
    ]);
  } finally {
    fs.rmSync(repo, { force: true, recursive: true });
  }
});

test("comparison mode reports historical baseline debt without blocking unchanged oversized files", () => {
  const repo = makeFixtureRepo();

  try {
    const baseRef = initializeGitFixture(repo);
    const baselinePath = writeBaseline(repo, [
      { path: "ui/src/pages/HugePage.tsx", lines: 7 },
    ]);

    const result = runAudit(repo, [
      "--baseline",
      baselinePath,
      "--compare-ref",
      baseRef,
      "--fail-on-regression",
    ]);
    assert.equal(result.status, 0, result.stderr);

    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.regressions, []);
    assert.deepEqual(output.baselineRegressions, [
      {
        path: "ui/src/pages/HugePage.tsx",
        lines: 8,
        baselineLines: 7,
        reason: "oversized file grew past baseline",
      },
    ]);
    assert.equal(output.comparisonRef, baseRef);
    assert.equal(output.comparisonBase, baseRef);
  } finally {
    fs.rmSync(repo, { force: true, recursive: true });
  }
});

test("comparison mode requires sentinel allowances for newly inventoried debt", () => {
  const repo = makeFixtureRepo();

  try {
    const baselinePath = writeBaseline(repo, []);
    const baseRef = initializeGitFixture(repo);
    writeBaseline(repo, [{ path: "ui/src/pages/HugePage.tsx", lines: 8 }]);

    const result = runAudit(repo, [
      "--baseline",
      baselinePath,
      "--compare-ref",
      baseRef,
      "--fail-on-regression",
    ]);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).governanceViolations, [
      {
        path: "ui/src/pages/HugePage.tsx",
        reason: "newly inventoried debt must use the 6-line sentinel allowance",
      },
    ]);
  } finally {
    fs.rmSync(repo, { force: true, recursive: true });
  }
});

test("comparison mode accepts metadata-only enrichment of a clean baseline entry", () => {
  const repo = makeFixtureRepo();

  try {
    const baselinePath = writeBaseline(
      repo,
      [{ path: "ui/src/pages/HugePage.tsx", lines: 8 }],
      { addMetadata: false },
    );
    const baseRef = initializeGitFixture(repo);
    writeBaseline(repo, [{ path: "ui/src/pages/HugePage.tsx", lines: 8 }]);

    const result = runAudit(repo, [
      "--baseline",
      baselinePath,
      "--compare-ref",
      baseRef,
      "--fail-on-regression",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).governanceViolations, []);
  } finally {
    fs.rmSync(repo, { force: true, recursive: true });
  }
});

test("comparison mode rejects a per-path baseline allowance increase", () => {
  const repo = makeFixtureRepo();

  try {
    const baselinePath = writeBaseline(
      repo,
      [{ path: "ui/src/pages/HugePage.tsx", lines: 7 }],
      { addMetadata: false },
    );
    const baseRef = initializeGitFixture(repo);
    writeBaseline(repo, [{ path: "ui/src/pages/HugePage.tsx", lines: 8 }]);

    const result = runAudit(repo, [
      "--baseline",
      baselinePath,
      "--compare-ref",
      baseRef,
      "--fail-on-regression",
    ]);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).governanceViolations, [
      {
        path: "ui/src/pages/HugePage.tsx",
        reason: "exception allowance increased from 7 to 8",
      },
    ]);
  } finally {
    fs.rmSync(repo, { force: true, recursive: true });
  }
});

test("comparison mode fails when an existing oversized file grows", () => {
  const repo = makeFixtureRepo();

  try {
    const baseRef = initializeGitFixture(repo);
    writeLines(path.join(repo, "ui", "src", "pages", "HugePage.tsx"), 9);

    const result = runAudit(repo, ["--compare-ref", baseRef, "--fail-on-regression"]);
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.regressions, [
      {
        path: "ui/src/pages/HugePage.tsx",
        lines: 9,
        baselineLines: 8,
        reason: "oversized file grew past comparison ref",
      },
    ]);
  } finally {
    fs.rmSync(repo, { force: true, recursive: true });
  }
});

test("comparison mode allows oversized files to shrink and rejects new threshold crossings", () => {
  const repo = makeFixtureRepo();

  try {
    writeLines(path.join(repo, "server", "src", "routes", "GrowingRoute.ts"), 5);
    const baseRef = initializeGitFixture(repo);
    writeLines(path.join(repo, "ui", "src", "pages", "HugePage.tsx"), 7);
    writeLines(path.join(repo, "server", "src", "routes", "GrowingRoute.ts"), 6);

    const result = runAudit(repo, ["--compare-ref", baseRef, "--fail-on-regression"]);
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.regressions, [
      {
        path: "server/src/routes/GrowingRoute.ts",
        lines: 6,
        baselineLines: 5,
        reason: "file crossed oversized threshold",
      },
    ]);
    assert.equal(
      output.regressions.some((entry) => entry.path === "ui/src/pages/HugePage.tsx"),
      false,
    );
  } finally {
    fs.rmSync(repo, { force: true, recursive: true });
  }
});

test("comparison mode rejects a new oversized production file", () => {
  const repo = makeFixtureRepo();

  try {
    const baseRef = initializeGitFixture(repo);
    writeLines(path.join(repo, "server", "src", "routes", "NewHugeRoute.ts"), 7);

    const result = runAudit(repo, ["--compare-ref", baseRef, "--fail-on-regression"]);
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.regressions, [
      {
        path: "server/src/routes/NewHugeRoute.ts",
        lines: 7,
        baselineLines: null,
        reason: "new oversized file",
      },
    ]);
  } finally {
    fs.rmSync(repo, { force: true, recursive: true });
  }
});

test("comparison mode allows pure renames and deletions but rejects growth after a rename", () => {
  const repo = makeFixtureRepo();

  try {
    const baseRef = initializeGitFixture(repo);
    const originalPath = path.join(repo, "ui", "src", "pages", "HugePage.tsx");
    const renamedPath = path.join(repo, "ui", "src", "pages", "RenamedHugePage.tsx");
    fs.renameSync(originalPath, renamedPath);

    const workingTreeRenameResult = runAudit(repo, ["--compare-ref", baseRef, "--fail-on-regression"]);
    assert.equal(workingTreeRenameResult.status, 0, workingTreeRenameResult.stderr);
    assert.deepEqual(JSON.parse(workingTreeRenameResult.stdout).regressions, []);

    commitFixture(repo, "rename oversized file");

    const renameResult = runAudit(repo, ["--compare-ref", baseRef, "--fail-on-regression"]);
    assert.equal(renameResult.status, 0, renameResult.stderr);
    assert.deepEqual(JSON.parse(renameResult.stdout).regressions, []);

    writeLines(renamedPath, 9);
    commitFixture(repo, "grow renamed oversized file");
    const growthResult = runAudit(repo, ["--compare-ref", baseRef, "--fail-on-regression"]);
    assert.equal(growthResult.status, 1);
    assert.deepEqual(JSON.parse(growthResult.stdout).regressions, [
      {
        path: "ui/src/pages/RenamedHugePage.tsx",
        lines: 9,
        baselineLines: 8,
        reason: "oversized file grew past comparison ref",
      },
    ]);

    fs.unlinkSync(renamedPath);
    commitFixture(repo, "delete oversized file");
    const deletionResult = runAudit(repo, ["--compare-ref", baseRef, "--fail-on-regression"]);
    assert.equal(deletionResult.status, 0, deletionResult.stderr);
    assert.deepEqual(JSON.parse(deletionResult.stdout).regressions, []);
  } finally {
    fs.rmSync(repo, { force: true, recursive: true });
  }
});
