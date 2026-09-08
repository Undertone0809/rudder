import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = join(new URL(".", import.meta.url).pathname, "..");
const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");

function workflowJob(jobName) {
  const start = workflow.indexOf(`\n  ${jobName}:\n`);
  assert.notEqual(start, -1, `missing workflow job ${jobName}`);
  const remaining = workflow.slice(start + 1);
  const next = remaining.slice(1).search(/^  [a-zA-Z0-9_-]+:\n/m);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + next + 2);
}

test("plans affected and merge-boundary qualification from one Test workflow", () => {
  assert.match(workflow, /^name: Test$/m);
  assert.match(workflow, /^  merge_group:$/m);
  assert.match(workflow, /scripts\/ci-impact-plan\.mjs/);
  assert.match(workflow, /Require exact trusted dispatch source/);
  assert.match(workflow, /name: Qualification summary/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /Non-required qualification family/);
  assert.match(workflow, /intentionally skipped/);
  assert.match(workflow, /MERGE_BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}/);
  assert.match(workflow, /--head-tree-sha/);
  assert.doesNotMatch(workflow, /test "\$DISPATCH_REF_SHA" = "\$SOURCE_SHA"/);
});

test("keeps the full graph behind planner outputs and affected checks separate", () => {
  const affected = workflowJob("affected");
  const architecture = workflowJob("architecture");
  const verify = workflowJob("verify");
  assert.match(affected, /@rudderhq\/ui typecheck/);
  assert.match(affected, /@rudderhq\/ui build/);
  assert.match(affected, /test:e2e --grep @smoke/);
  assert.match(architecture, /needs\.plan\.outputs\.comparison_sha/);
  assert.doesNotMatch(architecture, /HEAD\^2/);
  assert.match(verify, /RUDDER_NATIVE_ARCHIVE_PATH=.*desktop\/\.packaged\/native\/x86_64-unknown-linux-gnu\/rudder-native/);
  for (const jobName of ["architecture", "docs", "verify", "native-foundations", "desktop-packaged-smoke"]) {
    const job = workflowJob(jobName);
    assert.match(job, /needs: plan/);
    assert.match(job, /needs\.plan\.outputs\.run_/);
  }
});

test("prints the profile and identity tuple in the aggregate check", () => {
  const summary = workflowJob("qualification-summary");
  for (const field of ["PROFILE", "QUALIFICATION", "SOURCE_SHA", "COMPARISON_SHA", "PLAN_DIGEST"]) {
    assert.match(summary, new RegExp(field));
  }
  for (const family of ["architecture", "affected", "docs", "verify", "native", "desktop"]) {
    assert.match(summary, new RegExp(family));
  }
  assert.match(summary, /SOURCE_TREE_SHA/);
});
