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
  const native = workflowJob("native-foundations");
  assert.match(affected, /@rudderhq\/ui typecheck/);
  assert.match(affected, /@rudderhq\/ui build/);
  assert.match(affected, /test:e2e --grep @smoke/);
  assert.match(architecture, /needs\.plan\.outputs\.comparison_sha/);
  assert.doesNotMatch(architecture, /HEAD\^2/);
  assert.match(verify, /RUDDER_NATIVE_ARCHIVE_PATH=.*desktop\/\.packaged\/native\/x86_64-unknown-linux-gnu\/rudder-native/);
  assert.match(native, /name: Verify migration manifest differential parity/);
  assert.match(native, /if: matrix\.target == 'x86_64-unknown-linux-gnu'/);
  assert.match(native, /env -u DATABASE_URL pnpm verify:migration-manifest-differential/);
  for (const jobName of ["architecture", "docs", "verify", "native-foundations", "desktop-packaged-smoke"]) {
    const job = workflowJob(jobName);
    assert.match(job, /needs: plan/);
    assert.match(job, /needs\.plan\.outputs\.run_/);
  }
});

test("caches native PostgreSQL runtime payloads by runner and architecture", () => {
  const native = workflowJob("native-foundations");
  assert.match(native, /name: Cache PostgreSQL runtime payload/);
  assert.match(native, /path: \~\/\.rudder\/runtime-payloads\/postgres-18\.4/);
  assert.match(native, /key: postgres-runtime-18\.4-\$\{\{ runner\.os \}\}-\$\{\{ matrix\.arch \}\}-/);
  assert.match(native, /restore-keys: postgres-runtime-18\.4-\$\{\{ runner\.os \}\}-\$\{\{ matrix\.arch \}\}-/);
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

test("isolates real-entry Cargo caches by compilation profile before native builds", () => {
  const cases = [
    ["rust-d1-real-entry.yml", "d1-real-entry-dev-debug0-incremental0"],
    ["rust-authority-boundaries.yml", "authority-boundaries-dev-default"],
  ];
  const keys = new Set();
  for (const [file, key] of cases) {
    const source = readFileSync(join(repoRoot, ".github/workflows", file), "utf8");
    const caches = [...source.matchAll(/uses: Swatinem\/rust-cache@v2\n        with:\n          workspaces: native -> target\n          key: ([^\n]+)/g)];
    assert.equal(caches.length, 1, `${file} must configure exactly one native workspace cache`);
    assert.equal(caches[0][1], key);
    assert(caches[0].index > source.indexOf("uses: dtolnay/rust-toolchain@stable"), `${file} resolves the compiler before its cache`);
    assert(caches[0].index < source.indexOf("cargo build --locked"), `${file} restores cache before its first Cargo build`);
    assert(!keys.has(key), "different debug/incremental settings must not share a cache key");
    keys.add(key);
    if (file === "rust-d1-real-entry.yml") {
      assert.match(source, /CARGO_PROFILE_DEV_DEBUG: "0"/);
      assert.match(source, /CARGO_INCREMENTAL: "0"/);
    } else {
      assert.doesNotMatch(source, /CARGO_PROFILE_DEV_DEBUG:|CARGO_INCREMENTAL:/);
    }
  }
});
