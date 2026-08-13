import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowDir = join(repoRoot, ".github/workflows");
const testWorkflow = readFileSync(join(workflowDir, "ci.yml"), "utf8");
const releaseWorkflow = readFileSync(join(workflowDir, "release.yml"), "utf8");
const docsWorkflow = readFileSync(join(workflowDir, "docs-production.yml"), "utf8");
const nextReleaseScript = readFileSync(join(repoRoot, "scripts/prepare-next-release.mjs"), "utf8");

function workflowJob(source, jobName) {
  const start = source.indexOf(`\n  ${jobName}:\n`);
  if (start === -1) throw new Error(`Workflow job not found: ${jobName}`);
  const remaining = source.slice(start + 1);
  const next = remaining.slice(1).search(/^  [a-zA-Z0-9_-]+:\n/m);
  return next === -1 ? source.slice(start) : source.slice(start, start + next + 2);
}

describe("unified delivery workflows", () => {
  it("exposes Test, Release, and Docs Release as the delivery workflows", () => {
    expect(testWorkflow).toMatch(/^name: Test$/m);
    expect(releaseWorkflow).toMatch(/^name: Release$/m);
    expect(docsWorkflow).toMatch(/^name: Docs Release$/m);
    expect(existsSync(join(workflowDir, "desktop-release.yml"))).toBe(false);
    expect(existsSync(join(workflowDir, "public-install-smoke.yml"))).toBe(false);
    expect(existsSync(join(workflowDir, "docs-staging.yml"))).toBe(false);
  });

  it("binds Test and manual Release to one immutable source SHA", () => {
    expect(releaseWorkflow).toContain('workflows: ["Test"]');
    expect(releaseWorkflow).toContain('description: "Full commit SHA to promote as stable"');
    expect(releaseWorkflow).toContain("Require immutable stable source SHA");
    expect(releaseWorkflow).toContain("Require successful Test for exact source");
    expect(releaseWorkflow).toContain('actions/workflows/ci.yml/runs');
    expect(releaseWorkflow).toContain('-f head_sha="$SOURCE_SHA"');
    expect(releaseWorkflow).toContain('git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main');
    expect(testWorkflow).toContain("Require dispatch ref to match exact source");
    expect(testWorkflow).toContain('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"');
  });

  it("runs source, docs, platform, and fast packaged Desktop gates in Test", () => {
    expect(testWorkflow).toContain("Architecture ratchet");
    expect(testWorkflow).toContain("pnpm product-logic:check");
    expect(testWorkflow).toContain("pnpm test:run --maxWorkers=2");
    expect(testWorkflow).toContain("Ensure Electron runtime dependency");
    expect(testWorkflow).toContain("pnpm rebuild electron");
    expect(testWorkflow.indexOf("Ensure Electron runtime dependency"))
      .toBeLessThan(testWorkflow.indexOf("pnpm test:run --maxWorkers=2"));
    expect(testWorkflow).toContain("pnpm test:docs-search");
    expect(testWorkflow).toContain("node scripts/docs-content-map.mjs integrity");
    const desktop = workflowJob(testWorkflow, "desktop-packaged-smoke");
    expect(desktop).toContain("runs-on: macos-14");
    expect(desktop).toContain("pnpm desktop:dist");
    expect(desktop).toContain("--mode=packaged --scenario=account-gate");
  });

  it("builds npm and four Desktop candidates before either publish job", () => {
    const candidate = workflowJob(releaseWorkflow, "candidate-complete");
    const canary = workflowJob(releaseWorkflow, "publish-canary");
    const stable = workflowJob(releaseWorkflow, "publish-stable");
    expect(candidate).toContain("- npm-candidate");
    expect(candidate).toContain("- desktop-candidate");
    expect(canary).toContain("- candidate-complete");
    expect(stable).toContain("- candidate-complete");
    expect(releaseWorkflow).toMatch(/platform: macos\n\s+arch: x64/);
    expect(releaseWorkflow).toMatch(/platform: macos\n\s+arch: arm64/);
    expect(releaseWorkflow).toMatch(/platform: windows\n\s+arch: x64/);
    expect(releaseWorkflow).toMatch(/platform: linux\n\s+arch: x64/);
    expect(releaseWorkflow).toContain("Smoke packaged App Builder");
    expect(releaseWorkflow).toContain("Smoke staged PostgreSQL runtime");
    expect(releaseWorkflow).toContain("Smoke packaged account gate");
  });

  it("publishes only frozen run artifacts without dispatching or rebuilding Desktop", () => {
    const npmCandidate = workflowJob(releaseWorkflow, "npm-candidate");
    const desktopCandidate = workflowJob(releaseWorkflow, "desktop-candidate");
    const canary = workflowJob(releaseWorkflow, "publish-canary");
    const stable = workflowJob(releaseWorkflow, "publish-stable");
    expect(npmCandidate).toContain("npm pack --json");
    expect(npmCandidate).toContain("manifest.tsv");
    expect(desktopCandidate).toContain("pnpm desktop:dist");
    expect(desktopCandidate).toContain("actions/upload-artifact@v7");
    for (const publish of [canary, stable]) {
      expect(publish).toContain("actions/download-artifact@v8");
      expect(publish).toContain("pattern: npm-release-candidate");
      expect(publish).toContain("pattern: desktop-*");
      expect(publish).not.toContain("pnpm desktop:dist");
      expect(publish).not.toContain("gh workflow run desktop-release.yml");
    }
    expect(releaseWorkflow).not.toContain("desktop-release.yml");
    expect(releaseWorkflow).not.toContain("public-install-smoke.yml");
    expect(canary).toContain('test "$(find . -maxdepth 1 -type f -name \'Rudder-*\' | wc -l | xargs)" = "7"');
    expect(stable).toContain('test "$(find . -maxdepth 1 -type f -name \'Rudder-*\' | wc -l | xargs)" = "7"');
  });

  it("waits for the exact manifest versions before creating public release surfaces", () => {
    for (const jobName of ["publish-canary", "publish-stable"]) {
      const publish = workflowJob(releaseWorkflow, jobName);
      const waitIndex = publish.indexOf("wait_for_npm_package_versions");
      const tagIndex = publish.indexOf("git tag");
      const releaseIndex = publish.indexOf("gh release");
      expect(publish).toContain("awk -F '\\t' 'NF == 4");
      expect(waitIndex).toBeGreaterThan(-1);
      expect(tagIndex).toBeGreaterThan(waitIndex);
      expect(releaseIndex).toBeGreaterThan(waitIndex);
    }
  });

  it("keeps every irreversible publish action behind candidate-complete", () => {
    for (const jobName of ["preflight", "npm-candidate", "desktop-candidate", "candidate-complete"]) {
      const job = workflowJob(releaseWorkflow, jobName);
      expect(job).not.toContain("npm publish");
      expect(job).not.toContain("git push origin \"refs/tags/");
      expect(job).not.toContain("gh release create");
      expect(job).not.toContain("gh release upload");
    }
    expect(workflowJob(releaseWorkflow, "publish-canary")).toContain("npm publish");
    expect(workflowJob(releaseWorkflow, "publish-stable")).toContain("npm publish");
  });

  it("keeps dry runs read-only while exercising the complete candidate gate", () => {
    expect(releaseWorkflow).toContain('if [ "${DRY_RUN:-true}" = "true" ]; then publish="false"');
    expect(workflowJob(releaseWorkflow, "npm-candidate")).not.toContain("needs.preflight.outputs.publish");
    expect(workflowJob(releaseWorkflow, "desktop-candidate")).not.toContain("needs.preflight.outputs.publish");
    expect(workflowJob(releaseWorkflow, "publish-stable")).toContain("needs.preflight.outputs.publish == 'true'");
  });

  it("runs public install inside Release and requires stable docs before closeout", () => {
    const install = workflowJob(releaseWorkflow, "stable-install");
    const docs = workflowJob(releaseWorkflow, "stable-docs");
    const surfaces = workflowJob(releaseWorkflow, "stable-surfaces");
    const handoff = workflowJob(releaseWorkflow, "next-release-base");
    expect(install).toContain("Linux x64");
    expect(install).toContain("Windows x64");
    expect(install).toContain("macOS arm64");
    expect(install).toContain("node scripts/smoke-public-install.mjs");
    expect(docs).toContain("uses: ./.github/workflows/docs-production.yml");
    expect(docs).toContain("source_ref: ${{ needs.preflight.outputs.tag }}");
    expect(surfaces).toContain("- stable-docs");
    expect(surfaces).toContain("- stable-install");
    expect(handoff).toContain("- stable-surfaces");
    expect(handoff).toContain("- stable-cleanup");
  });

  it("fails closed when partial recovery finds different published artifacts", () => {
    const npmCandidate = workflowJob(releaseWorkflow, "npm-candidate");
    const desktopCandidate = workflowJob(releaseWorkflow, "desktop-candidate");
    const candidateComplete = workflowJob(releaseWorkflow, "candidate-complete");
    const stable = workflowJob(releaseWorkflow, "publish-stable");
    expect(releaseWorkflow).toContain('description: "Original Release run ID containing the verified candidate artifacts (required for resume)"');
    expect(releaseWorkflow).toContain('candidate_run_id is required when resume_missing is true.');
    expect(releaseWorkflow).toContain("Require matching verified candidate run for recovery");
    expect(releaseWorkflow).toContain("actions/runs/$CANDIDATE_RUN_ID");
    expect(releaseWorkflow).toContain("test \"$(jq -r '.head_sha' <<< \"$run_json\")\" = \"$SOURCE_SHA\"");
    expect(releaseWorkflow).toContain('test "$(jq -r \'.path\' <<< "$run_json")" = ".github/workflows/release.yml"');
    expect(releaseWorkflow).toContain("desktop-macos-arm64");
    expect(npmCandidate).toContain("if: needs.preflight.outputs.resume != 'true'");
    expect(desktopCandidate).toContain("if: needs.preflight.outputs.resume != 'true'");
    expect(candidateComplete).toContain("needs.npm-candidate.result == 'skipped'");
    expect(candidateComplete).toContain("needs.desktop-candidate.result == 'skipped'");
    expect(stable).toContain('run-id: ${{ needs.preflight.outputs.candidate_run_id }}');
    expect(stable).toContain('github-token: ${{ github.token }}');
    expect(stable).toContain('test "$RESUME_MISSING" = "true"');
    expect(stable).toContain("Existing release asset $asset does not match the verified candidate.");
    expect(stable).toContain('gh release upload "$RELEASE_TAG" SHASUMS256.txt --clobber');
    expect(stable).not.toContain("--force");
  });

  it("uses one qualified Docs Release and no staging deployment", () => {
    expect(docsWorkflow).toContain("workflow_dispatch:");
    expect(docsWorkflow).toContain("workflow_call:");
    expect(docsWorkflow).toContain("Require successful Test for exact source");
    expect(docsWorkflow).toContain("Require immutable docs source");
    expect(docsWorkflow).toContain('refs/tags/$SOURCE_REF');
    expect(docsWorkflow).not.toContain('default: "main"');
    expect(docsWorkflow).toContain('source_sha="$(git rev-parse HEAD)"');
    expect(docsWorkflow).toContain('-f head_sha="$source_sha"');
    expect(docsWorkflow).toContain("Deploy to Vercel production");
    expect(docsWorkflow).toContain("Verify production domains");
    expect(docsWorkflow).not.toContain("pnpm docs:structure:test");
    expect(docsWorkflow).not.toContain("node scripts/docs-content-map.mjs integrity");
  });

  it("keeps automatic canary and deterministic stable handoff behavior", () => {
    expect(releaseWorkflow).toContain('EVENT_NAME: ${{ github.event_name }}');
    expect(releaseWorkflow).toContain('if [ "$EVENT_NAME" = "workflow_run" ]; then');
    expect(releaseWorkflow).toContain("environment: npm-canary");
    expect(releaseWorkflow).toContain("environment: npm-stable");
    expect(releaseWorkflow).toMatch(/concurrency:\n  group: release-publish\n  cancel-in-progress: false/);
    expect(releaseWorkflow.match(/group: release-publish/g)).toHaveLength(1);
    expect(releaseWorkflow).toContain("node scripts/prepare-next-release.mjs");
    expect(releaseWorkflow).toContain("gh workflow run ci.yml");
    expect(nextReleaseScript).toContain("[skip release]");
  });
});
