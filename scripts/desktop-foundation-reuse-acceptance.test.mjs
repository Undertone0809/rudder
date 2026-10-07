// These are evidence-harness contracts, not real package/time acceptance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TARGETS, disablePublishing, summarizeJobs, validateArtifacts, validatePlan, validateProducers, validateRun, validateSource, verifyCopiedBytes } from "./desktop-foundation-reuse-acceptance.mjs";

const sha = (c) => c.repeat(40);
const context = { repository: "Undertone0809/rudder", headRepository: "Undertone0809/rudder", pr: 123, headSha: sha("a"), sourceSha: sha("b"), treeSha: sha("c"), baseSha: sha("d"), attempt: 1 };
const workflow = { id: 7, path: ".github/workflows/ci.yml", name: "Test" };
function fixture() {
  const run = { id: 1234, run_attempt: 1, workflow_id: 7, path: workflow.path, name: "Test", repository: { id: 1, full_name: context.repository }, head_repository: { id: 1, full_name: context.repository }, event: "pull_request", head_sha: context.headSha, head_branch: "codex/foundation-reuse", pull_requests: [{ number: 123, head: { sha: context.headSha }, base: { sha: context.baseSha } }], status: "completed", conclusion: "success" };
  const body = { profile: "pr_affected", qualification: "full", event: "pull_request", sourceSha: context.sourceSha, sourceTreeSha: context.treeSha, comparisonSha: context.baseSha, requiredFamilies: ["architecture", "docs", "verify", "native", "desktop"], fullQualification: true };
  const plan = { ...body, planDigest: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
  const artifacts = [`ci-impact-plan-${run.id}`, ...TARGETS.map((target) => `server-foundation-${target}`)].map((name, index) => ({ id: index + 1, name, expired: false, expires_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(), size_in_bytes: 1000, digest: `sha256:${"a".repeat(64)}`, workflow_run: { id: run.id, repository_id: 1, head_repository_id: 1, head_sha: run.head_sha, head_branch: run.head_branch } }));
  const jobs = ["Plan qualification profile", "Qualification summary", ...TARGETS.map((target) => `Server foundation artifact ${target} (${["aarch64-unknown-linux-gnu", "aarch64-pc-windows-msvc"].includes(target) ? "cross-compile" : "native-build"})`)].map((name) => ({ name, run_id: run.id, run_attempt: 1, status: "completed", conclusion: "success" }));
  return { run, plan, artifacts, jobs };
}
function redigest(plan) {
  const { planDigest, ...body } = plan;
  return { ...body, planDigest: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

test("accepts exact PR head metadata bound to the actual synthetic merge/tree plan", () => {
  const { run, plan, artifacts, jobs } = fixture();
  validateRun(run, workflow, context);
  validatePlan(plan, context);
  validateProducers(jobs, run);
  assert.equal(validateArtifacts(artifacts, run, context).length, 7);
});
for (const field of ["sourceSha", "sourceTreeSha", "comparisonSha"]) {
  test(`rejects a recomputed but wrong ${field} impact plan`, () => {
    const { plan } = fixture();
    assert.throws(() => validatePlan(redigest({ ...plan, [field]: sha("e") }), context));
  });
}
test("rejects plan tampering, affected qualification, wrong event/profile and missing required families", () => {
  const { plan } = fixture();
  assert.throws(() => validatePlan({ ...plan, sourceSha: sha("e") }, context));
  for (const patch of [{ qualification: "affected" }, { fullQualification: false }, { event: "push" }, { profile: "main_attest" }, { requiredFamilies: ["native"] }]) {
    assert.throws(() => validatePlan(redigest({ ...plan, ...patch }), context));
  }
});
test("rejects different repository, workflow, event, head, PR and base metadata", () => {
  const { run } = fixture();
  for (const patch of [{ repository: { id: 2, full_name: "attacker/rudder" } }, { head_repository: { id: 2, full_name: "attacker/rudder" } }, { workflow_id: 8 }, { name: "Release" }, { path: ".github/workflows/release.yml" }, { event: "workflow_run" }, { head_sha: sha("e") }, { pull_requests: [] }, { pull_requests: [{ number: 123, head: { sha: context.headSha }, base: { sha: sha("e") } }] }]) {
    assert.throws(() => validateRun({ ...run, ...patch }, workflow, context));
  }
});
test("rejects fork, malformed SHA, invalid attempt and invalid PR context", () => {
  for (const patch of [{ headRepository: "attacker/rudder" }, { sourceSha: "main" }, { attempt: 0 }, { pr: 0 }]) assert.throws(() => validateSource({ ...context, ...patch }));
  const { run } = fixture();
  assert.throws(() => validateRun({ ...run, run_attempt: 0 }, workflow, context));
  validateRun({ ...run, run_attempt: 2 }, workflow, { ...context, attempt: 2 });
});
test("requires every one of the six target artifacts", () => {
  const { run, artifacts } = fixture();
  for (let i = 1; i < artifacts.length; i += 1) assert.throws(() => validateArtifacts(artifacts.filter((_, index) => index !== i), run, context));
});
test("rejects duplicate, expired, near-expiry, wrong-run and malformed artifacts", () => {
  const { run, artifacts } = fixture();
  assert.throws(() => validateArtifacts([...artifacts, artifacts[1]], run, context));
  for (const patch of [{ expired: true }, { expires_at: new Date(Date.now() + 60_000).toISOString() }, { expires_at: "unknown" }, { id: -1 }, { size_in_bytes: 0 }, { size_in_bytes: 300 * 1024 * 1024 }, { digest: null }, { workflow_run: { ...artifacts[1].workflow_run, id: 999 } }, { workflow_run: { ...artifacts[1].workflow_run, head_repository_id: 2 } }, { workflow_run: { ...artifacts[1].workflow_run, head_sha: sha("e") } }]) {
    assert.throws(() => validateArtifacts(artifacts.map((artifact, i) => i === 1 ? { ...artifact, ...patch } : artifact), run, context));
  }
});
test("requires successful actual aggregate and every artifact producer", () => {
  const { run, jobs } = fixture();
  for (let i = 0; i < jobs.length; i += 1) {
    for (const conclusion of ["failure", "skipped", "cancelled", "timed_out", null]) {
      assert.throws(() => validateProducers(jobs.map((job, index) => index === i ? { ...job, conclusion } : job), run));
    }
  }
  assert.throws(() => validateProducers(jobs.slice(1), run));
  assert.throws(() => validateProducers([...jobs, jobs[0]], run));
  assert.throws(() => validateProducers(jobs, { ...run, conclusion: "failure" }));
  assert.throws(() => validateProducers(jobs, { ...run, status: "in_progress" }));
});
test("explicit publish guard changes only the unique macOS argument vector", () => {
  const line = 'const args = [electronBuilderCliPath, "--mac", "dir"];';
  const before = `// preserved\n${line}\nawait run(process.execPath, args);\n`;
  assert.equal(disablePublishing(before), before.replace('"dir"]', '"dir", "--publish", "never"]'));
  assert.throws(() => disablePublishing("unexpected source"));
  assert.throws(() => disablePublishing(`${line}\n${line}`));
});
test("byte proof rejects either copied payload mismatch", () => {
  const bytes = Buffer.from("real bytes are supplied at CI runtime");
  assert.match(verifyCopiedBytes(bytes, bytes, bytes), /^[a-f0-9]{64}$/);
  assert.throws(() => verifyCopiedBytes(bytes, Buffer.from("stale"), bytes));
  assert.throws(() => verifyCopiedBytes(bytes, bytes, Buffer.from("stale")));
});
test("terminal evidence keeps actual timeout/skipped results and timings but no API token or unrelated fields", () => {
  const result = summarizeJobs([{ name: "macOS x64", status: "completed", conclusion: "timed_out", token: "secret", started_at: "2026-10-05T00:00:00Z", completed_at: "2026-10-05T00:25:00Z", steps: [{ name: "Build", status: "completed", conclusion: "cancelled", started_at: "2026-10-05T00:10:00Z", completed_at: "2026-10-05T00:25:00Z" }, { name: "Smoke", conclusion: "skipped" }] }]);
  assert.equal(result[0].seconds, 1500);
  assert.equal(result[0].conclusion, "timed_out");
  assert.equal(result[0].phases[0].seconds, 900);
  assert.equal(result[0].phases[1].conclusion, "skipped");
  assert(!JSON.stringify(result).includes("secret"));
});

const workflowText = readFileSync(new URL("../.github/workflows/desktop-foundation-reuse-acceptance.yml", import.meta.url), "utf8");
function jobSection(id) { return workflowText.split(`  ${id}:\n`)[1]?.split(/^  [a-z]+:\n/m)[0] ?? ""; }
test("workflow is PR-only, read-only, no secrets/OIDC/environment, with checkout credentials disabled", () => {
  assert.match(workflowText, /on:\n  pull_request:/);
  assert.doesNotMatch(workflowText, /workflow_dispatch:|workflow_run:|pull_request_target:|\bwrite\b|secrets\.|id-token:|environment:|npm publish|gh (?:release|run rerun|workflow run)/);
  assert.match(workflowText, /permissions:\n  contents: read\n  actions: read/);
  assert.equal((workflowText.match(/uses: actions\/checkout@/g) ?? []).length, 3);
  assert.equal((workflowText.match(/persist-credentials: false/g) ?? []).length, 3);
  assert.doesNotMatch(workflowText, /uses: actions\/cache@/);
});
test("workflow preserves the actual macOS Intel 25-minute ceiling and isolates readiness waiting", () => {
  assert.match(jobSection("package"), /runs-on: macos-15-intel\n    timeout-minutes: 25/);
  assert.match(jobSection("readiness"), /runs-on: ubuntu-latest\n    timeout-minutes: 70/);
  assert.doesNotMatch(jobSection("package"), /acceptance\.mjs wait|sleep /);
  assert.match(jobSection("terminal"), /needs: \[readiness, package\]/);
  assert.match(jobSection("terminal"), /if: always\(\)/);
});
test("workflow keeps every canonical macOS x64 release gate in order", () => {
  const lane = jobSection("package");
  const gates = [
    'node server/scripts/stage-native.mjs --artifact-dir "$RUDDER_SERVER_FOUNDATION_ARTIFACT_DIR"',
    "pnpm install --frozen-lockfile", "node scripts/lint-imports.mjs", "release-compatibility-runtime.ts", "pnpm exec playwright install chromium",
    "node desktop/scripts/prepare-postgres-runtime.mjs", "acceptance.mjs prepare",
    'node scripts/release-package-map.mjs set-version "$RELEASE_VERSION"',
    "pnpm desktop:dist", "acceptance.mjs inspect", "node desktop/scripts/app-builder-smoke.mjs --packaged",
    '"$staged_runtime/bin/initdb"', '"$staged_runtime/bin/pg_ctl" --pgdata="$smoke_data" --options="-h 127.0.0.1 -p 55432" --wait start',
    '"$staged_runtime/bin/pg_ctl" --pgdata="$smoke_data" --mode=fast --wait stop',
    "node scripts/collect-desktop-release-assets.mjs", "acceptance.mjs assets",
  ];
  let previous = -1;
  for (const gate of gates) {
    const found = lane.indexOf(gate);
    assert(found > previous, `Missing/out-of-order gate: ${gate}`);
    previous = found;
  }
  assert.match(lane, /mv "\$source_runtime" "\$hidden_source_runtime"/);
  assert.match(lane, /trap restore_runtime EXIT/);
  const lintStep = lane.split("      - name: Lint scoped imports with locked TypeScript\n")[1]?.split("      - name:")[0] ?? "";
  assert.match(lintStep, /export GIT_INDEX_FILE="\$lint_root\/index"/);
  assert.match(lintStep, /git read-tree --empty/);
  assert.match(lintStep, /git add --/);
  for (const file of ["desktop/scripts/stage-native.mjs", "desktop/scripts/stage-native.test.mjs", "scripts/desktop-foundation-reuse-acceptance.mjs", "scripts/desktop-foundation-reuse-acceptance.test.mjs"]) assert(lintStep.includes(file));
  assert.match(lintStep, /test "\$\(git ls-files \| wc -l \| tr -d '\[:space:\]'\)" = 4/);
  assert.match(lintStep, /node scripts\/lint-imports\.mjs\n/);
  assert.doesNotMatch(lintStep, /--changed|--fix|--skip-dirty/);
  assert.doesNotMatch(lane, /continue-on-error:|RUDDER_.*(?:SKIP|TIMEOUT)/);
});
test("workflow downloads the revalidated artifact IDs and uploads only explicit bounded JSON evidence", () => {
  assert.match(workflowText, /artifact-ids: \$\{\{ steps\.recheck\.outputs\.artifact_ids \}\}/);
  assert.match(workflowText, /RUDDER_SERVER_FOUNDATION_ARTIFACT_DIR: \$\{\{ github\.workspace \}\}\/dist\/server-foundation-artifacts/);
  for (const block of workflowText.split("uses: actions/upload-artifact@v7").slice(1)) {
    const upload = block.split(/^  [a-z]+:\n/m)[0];
    assert.doesNotMatch(upload, /path:.*(?:\.zip|dist\/|\*|~\/)/);
    assert.match(upload, /retention-days: 7/);
    assert.match(upload, /\.json/);
  }
  assert.match(jobSection("readiness"), /node --test scripts\/desktop-foundation-reuse-acceptance\.test\.mjs/);
  assert.match(jobSection("package"), /pnpm exec vitest run desktop\/scripts\/stage-native\.test\.mjs/);
});
