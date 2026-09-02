import test from "node:test";
import assert from "node:assert/strict";
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
