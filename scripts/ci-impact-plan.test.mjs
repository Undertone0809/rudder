import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createImpactPlan } from "./ci-impact-plan.mjs";

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);

test("keeps UI-only pull requests affected and out of heavy native jobs", () => {
  const plan = createImpactPlan({
    event: "pull_request",
    baseSha: shaA,
    headSha: shaB,
    headTreeSha: "c".repeat(40),
    files: ["ui/src/pages/IssueDetail.tsx", "tests/e2e/issue-detail.spec.ts"],
  });

  assert.equal(plan.profile, "pr_affected");
  assert.equal(plan.qualification, "affected");
  assert.equal(plan.fullQualification, false);
  assert.deepEqual(plan.requiredFamilies, ["architecture", "affected"]);
  assert.deepEqual(plan.changedAreas, ["e2e", "ui"]);
  assert.equal(plan.comparisonSha, shaA);
  assert.equal(plan.sourceTreeSha, "c".repeat(40));
});

test("runs docs checks for docs-only pull requests without escalating", () => {
  const plan = createImpactPlan({
    event: "pull_request",
    files: ["docs/releases.mdx", "doc/engineering/DEVELOPING.md"],
  });

  assert.equal(plan.fullQualification, false);
  assert.deepEqual(plan.requiredFamilies, ["architecture", "docs"]);
  assert.deepEqual(plan.changedAreas, ["docs"]);
});

const authorityPolicyPaths = [
  "doc/plans/2026-10-16-rudder-rust-backend-authority-inventory.json",
  "scripts/rust-backend-authority-inventory.mjs",
  "scripts/rust-backend-authority-inventory.test.mjs",
];

test("bounds the exact authority policy and metadata PR to mandatory plan and architecture checks", () => {
  const plan = createImpactPlan({
    event: "pull_request", baseSha: shaA, headSha: shaB, headTreeSha: "c".repeat(40),
    files: [...authorityPolicyPaths].reverse(),
  });
  assert.equal(plan.profile, "pr_affected");
  assert.equal(plan.qualification, "affected");
  assert.equal(plan.fullQualification, false);
  assert.deepEqual(plan.changedPaths, authorityPolicyPaths);
  assert.deepEqual(plan.changedAreas, ["authority-policy"]);
  assert.deepEqual(plan.requiredFamilies, ["architecture"]);
  assert.deepEqual(plan.affectedScopes, []);
  assert.equal(plan.sourceSha, shaB);
  assert.equal(plan.sourceTreeSha, "c".repeat(40));
  assert.equal(plan.comparisonSha, shaA);
});

test("authority policy subsets and additional paths retain the existing qualification rules", () => {
  for (let mask = 0; mask < 7; mask += 1) {
    const files = authorityPolicyPaths.filter((_, index) => mask & (1 << index));
    const plan = createImpactPlan({ event: "pull_request", files });
    assert.notDeepEqual(plan.changedAreas, ["authority-policy"], JSON.stringify(files));
    assert.equal(plan.fullQualification, mask !== 1, JSON.stringify(files));
  }
  for (const extra of [
    "native/crates/server-foundation/src/lib.rs", "server/src/routes/issues.ts",
    "ui/src/App.tsx", "docs/releases.mdx", "pnpm-lock.yaml",
    ".github/workflows/ci.yml", "scripts/ci-impact-plan.mjs",
    "scripts/ci-impact-plan.test.mjs", "scripts/unclassified.mjs",
  ]) {
    const plan = createImpactPlan({ event: "pull_request", files: [...authorityPolicyPaths, extra] });
    assert.equal(plan.fullQualification, true, extra);
    assert.deepEqual(plan.requiredFamilies, ["architecture", "docs", "verify", "native", "desktop"], extra);
  }
});

test("the exact authority paths stay fully qualified outside pull requests", () => {
  for (const event of ["push", "merge_group", "workflow_dispatch", "repository_dispatch", ""]) {
    const plan = createImpactPlan({ event, files: authorityPolicyPaths });
    assert.equal(plan.fullQualification, true, event);
  }
  const normalized = createImpactPlan({
    event: "pull_request",
    files: [...authorityPolicyPaths, `./${authorityPolicyPaths[0]}`, authorityPolicyPaths[1].replaceAll("/", "\\")],
  });
  assert.deepEqual(normalized.changedAreas, ["authority-policy"]);
});

test("the actual planner CLI emits the required GitHub job gates and matching source report", () => {
  const temporary = mkdtempSync(join(tmpdir(), "rudder-ci-policy-"));
  try {
    const filesPath = join(temporary, "paths.txt");
    const outputPath = join(temporary, "github-output.txt");
    const reportPath = join(temporary, "plan.json");
    for (const { event, files, full } of [
      { event: "pull_request", files: authorityPolicyPaths, full: false },
      { event: "pull_request", files: [...authorityPolicyPaths, "native/Cargo.toml"], full: true },
      { event: "push", files: authorityPolicyPaths, full: true },
    ]) {
      writeFileSync(filesPath, `${files.join("\n")}\n`);
      const stdout = execFileSync(process.execPath, [
        fileURLToPath(new URL("./ci-impact-plan.mjs", import.meta.url)),
        "--event", event, "--files-from", filesPath,
        "--base-sha", shaA, "--head-sha", shaB, "--head-tree-sha", "c".repeat(40),
        "--output", outputPath, "--report", reportPath,
      ], { encoding: "utf8" });
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      assert.deepEqual(JSON.parse(stdout), report);
      const output = Object.fromEntries(readFileSync(outputPath, "utf8").trimEnd().split("\n").map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }));
      assert.equal(output.run_architecture, "true");
      assert.equal(output.run_affected, "false");
      assert.equal(output.run_native, String(full));
      assert.equal(output.run_desktop, String(full));
      assert.equal(output.run_verify, String(full));
      assert.equal(output.full_qualification, String(full));
      assert.equal(output.required_families, full ? "architecture,docs,verify,native,desktop" : "architecture");
      assert.equal(output.source_sha, shaB);
      assert.equal(output.comparison_sha, shaA);
      assert.equal(output.source_tree_sha, "c".repeat(40));
      assert.equal(output.plan_digest, report.planDigest);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("fails closed for shared, database, lockfile, native, desktop, and workflow changes", () => {
  for (const file of [
    "packages/shared/src/api.ts",
    "packages/db/src/schema/issues.ts",
    "pnpm-lock.yaml",
    "native/src/lib.rs",
    "desktop/src/main.ts",
    ".github/workflows/ci.yml",
  ]) {
    const plan = createImpactPlan({ event: "pull_request", files: [file] });
    assert.equal(plan.fullQualification, true, file);
    assert.deepEqual(plan.requiredFamilies, ["architecture", "docs", "verify", "native", "desktop"], file);
    assert.notEqual(plan.escalationReasons.length, 0, file);
  }
});

test("uses the lifecycle profile for merge queue, exact-source, and main runs", () => {
  for (const [event, profile] of [
    ["merge_group", "merge_full"],
    ["workflow_dispatch", "exact_source"],
    ["push", "main_attest"],
  ]) {
    const plan = createImpactPlan({ event, files: ["ui/src/App.tsx"] });
    assert.equal(plan.profile, profile);
    assert.equal(plan.qualification, "full");
    assert.equal(plan.fullQualification, true);
  }
});

test("qualifies native child transport and its process tests on every native platform", () => {
  for (const file of [
    "server/src/services/workspace-file-native.ts",
    "server/src/__tests__/workspace-file-native.test.ts",
  ]) {
    const plan = createImpactPlan({ event: "pull_request", files: [file] });
    assert.equal(plan.fullQualification, true, file);
    assert.deepEqual(plan.changedAreas, ["server"], file);
    assert.deepEqual(plan.requiredFamilies, ["architecture", "docs", "verify", "native", "desktop"], file);
    assert.ok(plan.escalationReasons.includes("native workspace child process boundary changed"), file);
  }
  const ordinaryServer = createImpactPlan({
    event: "pull_request",
    files: ["server/src/services/calendar.ts"],
  });
  assert.equal(ordinaryServer.fullQualification, false);
  assert.deepEqual(ordinaryServer.requiredFamilies, ["architecture", "affected"]);
});

test("unknown events and unbounded file scopes use full qualification", () => {
  const unknownEvent = createImpactPlan({ event: "repository_dispatch", files: [] });
  const emptyPullRequest = createImpactPlan({ event: "pull_request", files: [] });

  assert.equal(unknownEvent.fullQualification, true);
  assert.equal(emptyPullRequest.fullQualification, true);
  assert.match(emptyPullRequest.escalationReasons[0], /empty/);
});

test("normalizes duplicate paths and produces a stable but content-sensitive digest", () => {
  const first = createImpactPlan({ event: "pull_request", files: ["./ui/src/App.tsx", "ui/src/App.tsx"] });
  const second = createImpactPlan({ event: "pull_request", files: ["ui/src/App.tsx"] });
  const changed = createImpactPlan({ event: "pull_request", files: ["ui/src/Other.tsx"] });

  assert.equal(first.planDigest, second.planDigest);
  assert.notEqual(first.planDigest, changed.planDigest);
  assert.match(first.planDigest, /^[a-f0-9]{64}$/);
});
