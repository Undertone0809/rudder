// Evidence-only companion to desktop-foundation-reuse-acceptance.yml.
// No dispatch, retry, release, publication, credentials, or profile capture.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TARGETS = [
  "aarch64-apple-darwin", "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu",
  "aarch64-pc-windows-msvc", "x86_64-pc-windows-msvc",
];
const REPOSITORY = "Undertone0809/rudder";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const command = (name, args) => execFileSync(name, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
function writeEvidence(name, value) {
  const root = process.env.ACCEPTANCE_EVIDENCE_DIR;
  assert(root, "ACCEPTANCE_EVIDENCE_DIR is required");
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  assert(Buffer.byteLength(bytes) <= 256 * 1024, "Evidence exceeds 256 KiB per file");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, `${name}.json`), bytes);
}

export function validateSource(context) {
  assert.equal(context.repository, REPOSITORY, "Unexpected repository");
  for (const key of ["headSha", "sourceSha", "treeSha", "baseSha"]) {
    assert.match(context[key] ?? "", /^[a-f0-9]{40}$/, `Invalid ${key}`);
  }
  assert(Number.isSafeInteger(context.pr) && context.pr > 0, "Invalid PR number");
  assert.equal(context.headRepository, REPOSITORY, "Forks are outside this acceptance workflow");
  assert(Number.isSafeInteger(context.attempt) && context.attempt > 0, "Invalid acceptance attempt");
}

export function validateRun(run, workflow, context) {
  validateSource(context);
  assert.equal(workflow.path, ".github/workflows/ci.yml");
  assert.equal(workflow.name, "Test");
  assert.equal(run.workflow_id, workflow.id, "Wrong producer workflow ID");
  assert.equal(run.path, workflow.path, "Wrong producer workflow path");
  assert.equal(run.name, "Test");
  assert.equal(run.repository?.full_name, context.repository);
  assert.equal(run.head_repository?.full_name, context.repository);
  assert.equal(run.event, "pull_request", "Only the corresponding PR Test run is allowed");
  assert(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, "Invalid producer attempt");
  assert([context.headSha, context.sourceSha].includes(run.head_sha), "Producer head is not this PR head/merge");
  assert(run.pull_requests?.some((pr) => pr.number === context.pr
    && pr.head.sha === context.headSha && pr.base.sha === context.baseSha), "Producer PR/base identity differs");
}

export function validatePlan(plan, context) {
  const { planDigest, ...body } = plan;
  assert.equal(planDigest, sha256(JSON.stringify(body)), "Invalid impact-plan digest");
  assert.equal(plan.sourceSha, context.sourceSha, "Impact plan is not this exact synthetic merge");
  assert.equal(plan.sourceTreeSha, context.treeSha, "Impact-plan tree differs");
  assert.equal(plan.comparisonSha, context.baseSha, "Impact-plan comparison base differs");
  assert.equal(plan.event, "pull_request");
  assert.equal(plan.profile, "pr_affected");
  assert.equal(plan.qualification, "full");
  assert.equal(plan.fullQualification, true);
  assert.deepEqual([...plan.requiredFamilies].sort(), ["architecture", "desktop", "docs", "native", "verify"]);
}

export function validateArtifacts(artifacts, run, context, now = Date.now()) {
  const names = [`ci-impact-plan-${run.id}`, ...TARGETS.map((target) => `server-foundation-${target}`)];
  return names.map((name) => {
    const found = artifacts.filter((artifact) => artifact.name === name);
    assert.equal(found.length, 1, `Expected exactly one artifact ${name}`);
    const artifact = found[0];
    assert.equal(artifact.expired, false, `Expired ${name}`);
    assert(Date.parse(artifact.expires_at) > now + 35 * 60_000, `Artifact expires too soon: ${name}`);
    assert(Number.isSafeInteger(artifact.id) && artifact.id > 0);
    assert(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 256 * 1024 * 1024, `Unexpected size: ${name}`);
    assert.equal(artifact.workflow_run?.id, run.id, `Artifact belongs to another run: ${name}`);
    assert.equal(artifact.workflow_run?.repository_id, run.repository.id);
    assert.equal(artifact.workflow_run?.head_repository_id, run.head_repository.id);
    assert.equal(artifact.workflow_run?.head_sha, run.head_sha);
    assert.equal(artifact.workflow_run?.head_branch, run.head_branch);
    assert.match(artifact.digest ?? "", /^sha256:[a-f0-9]{64}$/, `Missing artifact digest: ${name}`);
    return { id: artifact.id, name, size: artifact.size_in_bytes, digest: artifact.digest, expiresAt: artifact.expires_at };
  });
}

export function validateProducers(jobs, run) {
  assert.equal(run.status, "completed", "Test is not terminal");
  assert.equal(run.conclusion, "success", "Test did not succeed");
  const names = ["Plan qualification profile", "Qualification summary", ...TARGETS.map((target) => {
    const mode = ["aarch64-unknown-linux-gnu", "aarch64-pc-windows-msvc"].includes(target) ? "cross-compile" : "native-build";
    return `Server foundation artifact ${target} (${mode})`;
  })];
  for (const name of names) {
    const matches = jobs.filter((job) => job.name === name);
    assert.equal(matches.length, 1, `Missing/duplicate producer job ${name}`);
    const job = matches[0];
    assert.equal(job.run_id, run.id);
    assert.equal(job.run_attempt, run.run_attempt);
    assert.equal(job.status, "completed");
    assert.equal(job.conclusion, "success", `Producer failed: ${name}`);
  }
}

function api(route) {
  assert(route.startsWith(`repos/${REPOSITORY}/`), "Unexpected API destination");
  return JSON.parse(command("gh", ["api", "--method", "GET", route]));
}
function pages(route, key) {
  assert(route.startsWith(`repos/${REPOSITORY}/`), "Unexpected API destination");
  const pages = JSON.parse(command("gh", ["api", "--method", "GET", "--paginate", "--slurp", route]));
  assert(pages.length <= 10, "Unexpected API pagination");
  return pages.flatMap((page) => page[key]);
}
function sourceContext() {
  const event = json(process.env.GITHUB_EVENT_PATH);
  const context = {
    repository: process.env.GITHUB_REPOSITORY,
    pr: event.pull_request?.number,
    headRepository: event.pull_request?.head.repo.full_name,
    headSha: event.pull_request?.head.sha,
    baseSha: event.pull_request?.base.sha,
    sourceSha: process.env.GITHUB_SHA,
    treeSha: command("git", ["rev-parse", "HEAD^{tree}"]).trim(),
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  };
  validateSource(context);
  assert.equal(command("git", ["rev-parse", "HEAD"]).trim(), context.sourceSha);
  assert.deepEqual(command("git", ["show", "-s", "--format=%P", "HEAD"]).trim().split(" "), [context.baseSha, context.headSha], "Synthetic merge parents differ");
  return context;
}
function readPlan(artifact) {
  assert(artifact.size <= 1024 * 1024, "Impact-plan archive exceeds 1 MiB");
  const zip = execFileSync("gh", ["api", "--method", "GET", `repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  assert.equal(`sha256:${sha256(zip)}`, artifact.digest, "Impact-plan archive digest differs");
  const zipPath = path.join(process.env.RUNNER_TEMP, `foundation-impact-${artifact.id}.zip`);
  writeFileSync(zipPath, zip);
  assert.equal(command("unzip", ["-Z1", zipPath]).trim(), "ci-impact-plan.json", "Unexpected impact-plan ZIP contents");
  const plan = execFileSync("unzip", ["-p", zipPath, "ci-impact-plan.json"], { encoding: "utf8", maxBuffer: 256 * 1024 });
  return JSON.parse(plan);
}

async function waitForArtifacts({ once = false } = {}) {
  const context = sourceContext();
  const workflow = api(`repos/${REPOSITORY}/actions/workflows/ci.yml`);
  const deadline = Date.now() + (once ? 0 : 65 * 60_000);
  const startedAt = new Date().toISOString();
  do {
    const runs = once
      ? [api(`repos/${REPOSITORY}/actions/runs/${process.env.FOUNDATION_RUN_ID}`)]
      : pages(`repos/${REPOSITORY}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${context.headSha}&per_page=100`, "workflow_runs");
    for (const run of runs.sort((a, b) => b.id - a.id)) {
      try { validateRun(run, workflow, context); } catch (error) {
        if (once) throw error;
        continue; // An older base with the same PR head is not this candidate.
      }
      if (run.status !== "completed") continue;
      assert.equal(run.conclusion, "success", `Exact Test run ${run.id} ended ${run.conclusion}`);
      const jobs = pages(`repos/${REPOSITORY}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, "jobs");
      validateProducers(jobs, run);
      const artifacts = validateArtifacts(pages(`repos/${REPOSITORY}/actions/runs/${run.id}/artifacts?per_page=100`, "artifacts"), run, context);
      const plan = readPlan(artifacts[0]);
      validatePlan(plan, context);
      const receipt = { context, producer: { id: run.id, attempt: run.run_attempt, workflowId: run.workflow_id, path: run.path, headSha: run.head_sha, conclusion: run.conclusion }, plan, artifacts, startedAt, completedAt: new Date().toISOString() };
      writeEvidence("foundation-source", receipt);
      const baseVersion = json("desktop/package.json").version;
      assert.match(baseVersion, /^\d+\.\d+\.\d+$/);
      const version = `${baseVersion}-canary.${process.env.GITHUB_RUN_ID}`;
      assert.match(version, /^\d+\.\d+\.\d+-canary\.\d+$/);
      if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, [
        `run_id=${run.id}`, `artifact_ids=${artifacts.slice(1).map((a) => a.id).join(",")}`,
        `source_sha=${context.sourceSha}`, `tree_sha=${context.treeSha}`, `version=${version}`,
      ].join("\n") + "\n", { flag: "a" });
      console.log(`Exact Test ${run.id}, synthetic merge ${context.sourceSha}, tree ${context.treeSha}: all six artifacts qualified`);
      return;
    }
    if (once || Date.now() >= deadline) break;
    console.log("Waiting for exact PR Test qualification and all six successful artifact producers");
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  } while (Date.now() < deadline);
  throw new Error("Exact-source artifact readiness did not complete within its separate 65-minute bound");
}

// The only diagnostic source transformation. Fail closed if the upstream
// invocation changes; preserve every packaging gate and record both hashes.
export function disablePublishing(source) {
  const before = 'const args = [electronBuilderCliPath, "--mac", "dir"];';
  assert.equal(source.split(before).length - 1, 1, "Unexpected macOS electron-builder invocation");
  return source.replace(before, 'const args = [electronBuilderCliPath, "--mac", "dir", "--publish", "never"];');
}
function prepareCandidate() {
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "x64");
  assert.equal(command("git", ["diff", "--name-only"]).trim(), "", "Unexpected tracked mutations before diagnostic setup");
  const file = "desktop/scripts/dist.mjs";
  const before = readFileSync(file, "utf8");
  const after = disablePublishing(before);
  writeFileSync(file, after);
  const tracked = [".github/workflows/ci.yml", ".github/workflows/release.yml", ".github/workflows/desktop-foundation-reuse-acceptance.yml", "desktop/scripts/stage-native.mjs", "desktop/scripts/stage-native.test.mjs", "scripts/desktop-foundation-reuse-acceptance.mjs", "scripts/desktop-foundation-reuse-acceptance.test.mjs"];
  writeEvidence("runtime-source", {
    source: sourceContext(), node: process.version, os: os.release(), platform: process.platform, arch: process.arch,
    runnerImage: process.env.ImageVersion, pnpm: command("pnpm", ["--version"]).trim(),
    rustc: command("rustc", ["--version"]).trim(), cargo: command("cargo", ["--version"]).trim(),
    electron: json("desktop/node_modules/electron/package.json").version,
    electronBuilder: json("desktop/node_modules/electron-builder/package.json").version,
    sourceVersion: json("desktop/package.json").version, candidateVersion: process.env.RELEASE_VERSION,
    files: Object.fromEntries(tracked.map((name) => [name, sha256(readFileSync(name))])),
    diagnosticOnly: { path: file, beforeSha256: sha256(before), afterSha256: sha256(after), change: "macOS electron-builder argv adds --publish never; generated package configuration is unchanged" },
  });
}

export function verifyCopiedBytes(input, staged, packaged) {
  const hashes = [input, staged, packaged].map(sha256);
  assert.equal(hashes[0], hashes[1], "Staged foundation is not the supplied artifact");
  assert.equal(hashes[0], hashes[2], "Packaged foundation is not the supplied artifact");
  return hashes[0];
}
function inspectPackage() {
  const target = "x86_64-apple-darwin";
  const resources = ["desktop/release/mac/Rudder.app/Contents/Resources", "desktop/release/mac-x64/Rudder.app/Contents/Resources"].filter(existsSync);
  assert.equal(resources.length, 1, "Expected exactly one real packaged macOS x64 app");
  const dirs = [path.join(process.env.RUDDER_SERVER_FOUNDATION_ARTIFACT_DIR, target), `desktop/.packaged/native/${target}`, `${resources[0]}/native/${target}`];
  const files = dirs.map((dir) => path.join(dir, "rudder-server-foundation"));
  for (const file of files) assert(lstatSync(file).isFile(), "Foundation must be a regular non-symlink file");
  const hash = verifyCopiedBytes(...files.map((file) => readFileSync(file)));
  const version = process.env.RELEASE_VERSION;
  const inputPreflight = path.join(dirs[0], "migration-preflight");
  const binaries = [];
  for (const dir of dirs.slice(1)) {
    for (const name of ["rudder-native", "rudder-process-host", "rudder-update-helper", "migration-preflight"]) {
      const file = path.join(dir, name);
      assert(lstatSync(file).isFile());
      const reported = execFileSync(file, ["--version"], { encoding: "utf8", timeout: 5_000, maxBuffer: 4096 }).trim();
      assert.equal(reported, `${name} ${version}${name === "rudder-update-helper" ? " protocol=1" : ""}`, "Rebuilt binary version mismatch");
      binaries.push({ path: file, sha256: sha256(readFileSync(file)), version: reported });
    }
  }
  assert.notEqual(sha256(readFileSync(inputPreflight)), binaries.find((b) => b.path.endsWith("/migration-preflight")).sha256, "Versioned preflight was copied instead of rebuilt");
  writeEvidence("packaged-native", { target, candidateVersion: version, foundation: { sha256: hash, paths: files.map((file) => path.relative(process.cwd(), file)) }, inputPreflightSha256: sha256(readFileSync(inputPreflight)), binaries });
}
function recordMutations() {
  const runtime = json(path.join(process.env.ACCEPTANCE_EVIDENCE_DIR, "runtime-source.json"));
  assert.notEqual(runtime.sourceVersion, process.env.RELEASE_VERSION, "Candidate must exercise a real version change");
  assert.equal(json("desktop/package.json").version, process.env.RELEASE_VERSION);
  const names = command("git", ["diff", "--name-only"]).trim().split("\n");
  assert(names.includes("native/Cargo.toml") && names.includes("native/Cargo.lock") && names.includes("desktop/scripts/dist.mjs"));
  const files = names.map((name) => {
    assert(name.endsWith("/package.json") || ["native/Cargo.toml", "native/Cargo.lock", "cli/src/program.ts", "desktop/scripts/dist.mjs"].includes(name), `Unexpected diagnostic mutation: ${name}`);
    return { path: name, beforeSha256: sha256(command("git", ["show", `HEAD:${name}`])), afterSha256: sha256(readFileSync(name)) };
  });
  writeEvidence("diagnostic-mutations", { sourceVersion: runtime.sourceVersion, candidateVersion: process.env.RELEASE_VERSION, versionCommand: "node scripts/release-package-map.mjs set-version $RELEASE_VERSION", publishing: runtime.diagnosticOnly, files });
}
async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function collectAssets() {
  const names = readdirSync("dist/desktop-assets").sort();
  const expected = ["portable", "shell"].map((kind) => `Rudder-${process.env.RELEASE_VERSION}-macos-x64-${kind}.zip`).sort();
  assert.deepEqual(names, expected, "Expected exact portable and shell assets");
  const native = json(path.join(process.env.ACCEPTANCE_EVIDENCE_DIR, "packaged-native.json"));
  const assets = [];
  for (const name of names) {
    const file = path.join("dist/desktop-assets", name);
    const stat = lstatSync(file);
    assert(stat.isFile() && stat.size > 0);
    const zippedNative = {};
    for (const binary of ["rudder-server-foundation", "migration-preflight"]) {
      const entry = `Rudder.app/Contents/Resources/native/x86_64-apple-darwin/${binary}`;
      const bytes = execFileSync("unzip", ["-p", file, entry], { timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
      const expectedHash = binary === "rudder-server-foundation" ? native.foundation.sha256 : native.binaries.find((b) => b.path.endsWith("/migration-preflight")).sha256;
      assert.equal(sha256(bytes), expectedHash, `Collected ${name} ${binary} differs from verified package`);
      zippedNative[binary] = expectedHash;
    }
    assets.push({ name, bytes: stat.size, sha256: await hashFile(file), zippedNative });
  }
  writeEvidence("collected-assets", assets);
}

export function summarizeJobs(jobs) {
  return jobs.map((job) => ({
    id: job.id, name: job.name, status: job.status, conclusion: job.conclusion,
    startedAt: job.started_at, completedAt: job.completed_at,
    seconds: job.completed_at && job.started_at ? (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000 : null,
    phases: (job.steps ?? []).map((step) => ({ name: step.name, status: step.status, conclusion: step.conclusion, startedAt: step.started_at, completedAt: step.completed_at,
      seconds: step.completed_at && step.started_at ? (Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000 : null })),
  }));
}
function terminalEvidence() {
  const route = `repos/${REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`;
  const jobs = pages(route, "jobs").filter((job) => ["Exact Test artifact readiness", "macOS x64 package acceptance (25 minute ceiling)"].includes(job.name));
  assert.equal(jobs.length, 2, "Missing terminal job metadata");
  assert(jobs.every((job) => job.status === "completed"), "Candidate jobs are not terminal");
  const summary = { source: sourceContext(), runId: process.env.GITHUB_RUN_ID, result: jobs.every((job) => job.conclusion === "success") ? "PASS" : "FAIL", scope: "Read-only macOS x64 package qualification; not release authorization or cross-platform acceptance", jobs: summarizeJobs(jobs) };
  writeEvidence("terminal-outcomes", summary);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.result !== "PASS") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const commands = { wait: () => waitForArtifacts(), recheck: () => waitForArtifacts({ once: true }), prepare: prepareCandidate, mutations: recordMutations, inspect: inspectPackage, assets: collectAssets, terminal: terminalEvidence };
  try {
    assert(commands[process.argv[2]], "Unknown acceptance command");
    await commands[process.argv[2]]();
  } catch (error) {
    console.error(`[foundation-reuse acceptance] ${error.message}`);
    process.exitCode = 1;
  }
}
