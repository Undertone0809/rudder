import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowDir = join(repoRoot, ".github/workflows");
const testWorkflow = readFileSync(join(workflowDir, "ci.yml"), "utf8");
const releaseWorkflow = readFileSync(join(workflowDir, "release.yml"), "utf8");
const docsWorkflow = readFileSync(join(workflowDir, "docs-production.yml"), "utf8");
const releaseSetup = readFileSync(join(repoRoot, "doc/engineering/RELEASE-AUTOMATION-SETUP.md"), "utf8");
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
    expect(testWorkflow).toContain("pnpm --filter @rudderhq/desktop rebuild electron");
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
    const preflight = workflowJob(releaseWorkflow, "preflight");
    const desktop = workflowJob(releaseWorkflow, "desktop-candidate");
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
    expect(preflight).toContain("Verify migration compatibility manifest");
    expect(preflight).toContain("scripts/release-compatibility-matrix.mjs");
    expect(desktop).toContain("timeout-minutes: 25");
    expect(desktop).toContain("pnpm --filter @rudderhq/db exec tsx ../../scripts/release-compatibility-runtime.ts");
    expect(desktop.indexOf("pnpm --filter @rudderhq/db exec tsx ../../scripts/release-compatibility-runtime.ts"))
      .toBeLessThan(desktop.indexOf("pnpm desktop:dist"));
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
      expect(publish).toContain("publish-github-release-assets-immutable.mjs");
      expect(publish).toContain("--phase binaries");
      expect(publish).not.toContain("--phase checksum");
      expect(publish).not.toContain("gh release upload");
    }
    expect(releaseWorkflow).not.toContain("desktop-release.yml");
    expect(releaseWorkflow).not.toContain("public-install-smoke.yml");
    expect(canary).toContain('test "$(find . -maxdepth 1 -type f -name \'Rudder-*\' | wc -l | xargs)" = "7"');
    expect(stable).toContain('test "$(find . -maxdepth 1 -type f -name \'Rudder-*\' | wc -l | xargs)" = "7"');
  });

  it("requires Tencent COS mirror jobs before publishing the GitHub checksum marker", () => {
    const canaryPublish = workflowJob(releaseWorkflow, "publish-canary");
    const stablePublish = workflowJob(releaseWorkflow, "publish-stable");
    const canaryMirror = workflowJob(releaseWorkflow, "mirror-canary");
    const stableMirror = workflowJob(releaseWorkflow, "mirror-stable");
    for (const [publish, mirror] of [
      [canaryPublish, canaryMirror],
      [stablePublish, stableMirror],
    ]) {
      expect(publish).toContain("--phase binaries");
      expect(publish).not.toContain("--phase checksum");
      expect(mirror).toContain("environment: desktop-release-mirror");
      expect(mirror).toContain("id-token: write");
      expect(mirror).toContain("timeout-minutes: 240");
      expect(mirror).toContain("pattern: desktop-*");
      expect(mirror).toContain("mirror-desktop-release-to-cos.mjs");
      expect(mirror).toContain("TENCENT_CLOUD_OIDC_PROVIDER_ID");
      expect(mirror).toContain("TENCENT_CLOUD_ROLE_ARN");
      expect(mirror).toContain("TENCENT_COS_BUCKET");
      expect(mirror).toContain("TENCENT_COS_REGION");
      const cosIndex = mirror.indexOf("mirror-desktop-release-to-cos.mjs");
      const markerIndex = mirror.indexOf("--phase checksum");
      expect(cosIndex).toBeGreaterThan(-1);
      expect(markerIndex).toBeGreaterThan(cosIndex);
    }
    expect(canaryMirror).toContain("- publish-canary");
    expect(stableMirror).toContain("- publish-stable");
    expect(stableMirror).toContain("run-id: ${{ needs.preflight.outputs.candidate_run_id }}");
    expect(stableMirror).toContain("github-token: ${{ github.token }}");
  });

  it("supports explicit COS-only recovery from frozen stable artifacts", () => {
    const recovery = workflowJob(releaseWorkflow, "mirror-recovery");
    expect(releaseWorkflow).toContain("mirror_recovery:");
    expect(releaseWorkflow).toContain("recovery_tag:");
    expect(workflowJob(releaseWorkflow, "preflight")).toContain(
      "github.event.inputs.mirror_recovery != 'true'",
    );
    expect(recovery).toContain("github.event.inputs.mirror_recovery == 'true'");
    expect(releaseWorkflow).not.toContain("inputs.mirror_recovery != true");
    expect(releaseWorkflow).not.toContain("inputs.mirror_recovery == true");
    expect(recovery).toContain("environment: desktop-release-mirror");
    expect(recovery).toContain("id-token: write");
    expect(recovery).toContain("timeout-minutes: 240");
    expect(recovery.match(/uses: actions\/download-artifact@v8/g)).toHaveLength(3);
    expect(recovery.match(/continue-on-error: true/g)).toHaveLength(3);
    expect(recovery.match(/run-id: \$\{\{ inputs\.candidate_run_id \}\}/g)).toHaveLength(3);
    for (const attempt of [1, 2, 3]) {
      expect(recovery.match(new RegExp(`id: download_candidate_assets_attempt_${attempt}`, "g"))).toHaveLength(1);
    }
    expect(
      recovery.match(/^\s+if: steps\.download_candidate_assets_attempt_1\.outcome == 'failure'$/gm),
    ).toHaveLength(1);
    expect(
      recovery.match(
        /^\s+if: steps\.download_candidate_assets_attempt_1\.outcome == 'failure' && steps\.download_candidate_assets_attempt_2\.outcome == 'failure'$/gm,
      ),
    ).toHaveLength(1);
    expect(recovery).toContain("if: always()");
    expect(recovery).toContain("Require frozen candidate desktop assets");
    expect(recovery).toContain("steps.download_candidate_assets_attempt_1.outcome");
    expect(recovery).toContain("steps.download_candidate_assets_attempt_2.outcome");
    expect(recovery).toContain("steps.download_candidate_assets_attempt_3.outcome");
    expect(recovery).toContain('= "success"');
    expect(recovery).toContain("ref: ${{ github.sha }}");
    expect(recovery).not.toContain("ref: ${{ inputs.source_ref }}");
    expect(recovery).toContain("WORKFLOW_SHA: ${{ github.sha }}");
    expect(recovery.match(/^\s+WORKFLOW_SHA:/gm)).toHaveLength(1);
    expect(recovery).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(recovery).toContain('test "$(git rev-parse HEAD)" = "$WORKFLOW_SHA"');
    expect(recovery).toContain('git cat-file -e "$SOURCE_REF^{commit}"');
    expect(recovery).toContain("git merge-base --is-ancestor \"$SOURCE_REF\" refs/remotes/origin/main");
    expect(recovery).toContain("success|cancelled|failure");
    expect(recovery).toContain("actions/runs/$CANDIDATE_RUN_ID/jobs?per_page=100");
    expect(recovery).toContain(".name == \"Publish stable\" and .conclusion == \"success\"");
    expect(recovery).toContain(".name == \"Mirror stable Desktop release to Tencent COS\" and .conclusion == \"failure\"");
    expect(recovery).toContain("test \"$SOURCE_REF\" = \"$remote_tag_sha\"");
    expect(recovery).not.toContain("jq -r '.head_sha' <<< \"$run_json\"");
    expect(recovery).toContain("SOURCE_REF: ${{ inputs.source_ref }}");
    expect(recovery).toContain(".prerelease");
    expect(recovery).toContain("mirror-desktop-release-to-cos.mjs");
    const sevenBinaryAssertion = recovery.indexOf(
      'test "$(find dist/desktop-assets -maxdepth 1 -type f -name \'Rudder-*\' | wc -l | xargs)" = "7"',
    );
    const cosMirror = recovery.indexOf("mirror-desktop-release-to-cos.mjs");
    expect(sevenBinaryAssertion).toBeGreaterThan(-1);
    expect(cosMirror).toBeGreaterThan(sevenBinaryAssertion);
    expect(recovery).toContain("--tag \"${{ inputs.recovery_tag }}\"");
    expect(recovery).toContain("--phase checksum");
    expect(recovery).not.toContain("npm publish");
    expect(recovery).not.toContain("git push");
    expect(recovery).toContain("class AbortProbeMirror extends CosReleaseMirror");
    expect(recovery).toContain("multipartThreshold: 1");
    expect(recovery).toContain("expected 204");
    expect(recovery).toContain("publicObject.status !== 404");
    expect(recovery).toContain("COS mirror attempt ${attempt}/3");
  });

  it("documents the complete COS object and multipart permission set", () => {
    const requiredActions = [
      "name/cos:HeadObject",
      "name/cos:GetObject",
      "name/cos:PutObject",
      "name/cos:InitiateMultipartUpload",
      "name/cos:UploadPart",
      "name/cos:CompleteMultipartUpload",
      "name/cos:AbortMultipartUpload",
    ];
    for (const action of requiredActions) expect(releaseSetup).toContain(action);
    expect(releaseSetup).toContain("name/cos:GetObject` alone returns `403`");
    expect(releaseSetup).not.toContain("HEAD` existence check is covered by COS's `GetObject`");
  });

  it("prevents canary and stable install gates from bypassing the COS mirror", () => {
    const canaryInstall = workflowJob(releaseWorkflow, "canary-install");
    const stableInstall = workflowJob(releaseWorkflow, "stable-install");
    const stableSurfaces = workflowJob(releaseWorkflow, "stable-surfaces");
    expect(canaryInstall).toContain("- mirror-canary");
    expect(canaryInstall).toContain("needs.mirror-canary.result == 'success'");
    expect(stableInstall).toContain("- mirror-stable");
    expect(stableInstall).toContain("needs.mirror-stable.result == 'success'");
    expect(stableSurfaces).toContain("- mirror-stable");
    expect(stableSurfaces).toContain("needs.mirror-stable.result == 'success'");
  });

  it("retries transient COS mirror failures before failing the release gate", () => {
    for (const jobName of ["mirror-recovery", "mirror-canary", "mirror-stable"]) {
      const job = workflowJob(releaseWorkflow, jobName);
      expect(job).toContain("for attempt in 1 2 3");
      expect(job).toContain("COS mirror attempt ${attempt}/3");
      expect(job).toContain('if [ "$status" -ne 75 ] || [ "$attempt" -eq 3 ]');
      expect(job).toContain('exit "$status"');
    }
  });

  it("runs mirror recovery from trusted main workflow code while preserving the released source", () => {
    const recovery = workflowJob(releaseWorkflow, "mirror-recovery");
    expect(recovery).toContain("ref: ${{ github.sha }}");
    expect(recovery).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(recovery).toContain('git cat-file -e "$SOURCE_REF^{commit}"');
    expect(recovery).toContain('test "$SOURCE_REF" = "$remote_tag_sha"');
  });

  it("waits for the exact manifest versions before creating public release surfaces", () => {
    for (const jobName of ["publish-canary", "publish-stable"]) {
      const publish = workflowJob(releaseWorkflow, jobName);
      const waitIndex = publish.indexOf("wait_for_npm_package_versions");
      const tagIndex = publish.indexOf("git tag");
      const releaseIndexes = [
        publish.indexOf("gh release"),
        publish.indexOf("create-github-release.sh"),
      ].filter((index) => index >= 0);
      const releaseIndex = Math.min(...releaseIndexes);
      expect(publish).toContain("awk -F '\\t' 'NF == 4");
      expect(waitIndex).toBeGreaterThan(-1);
      expect(tagIndex).toBeGreaterThan(waitIndex);
      expect(releaseIndexes).not.toHaveLength(0);
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
    const stablePublish = workflowJob(releaseWorkflow, "publish-stable");
    expect(stablePublish).toContain("github.event.inputs.dry_run == 'false'");
    expect(stablePublish).not.toContain("inputs.dry_run == false");
    expect(stablePublish).not.toContain("needs.preflight.outputs.publish");
  });

  it("routes real stable resumes through publish and fails closed on an incomplete chain", () => {
    const stablePublish = workflowJob(releaseWorkflow, "publish-stable");
    const releaseResult = workflowJob(releaseWorkflow, "stable-release-result");
    expect(stablePublish).toContain("github.event_name == 'workflow_dispatch'");
    expect(stablePublish).toContain("github.event.inputs.mirror_recovery != 'true'");
    expect(stablePublish).toContain("github.event.inputs.dry_run == 'false'");
    expect(stablePublish).not.toContain("needs.preflight.outputs.channel");
    expect(stablePublish).not.toContain("needs.preflight.outputs.publish");
    expect(releaseResult).toContain("always()");
    expect(releaseResult).toContain("github.event.inputs.mirror_recovery != 'true'");
    expect(releaseResult).toContain("github.event.inputs.dry_run == 'false'");
    for (const jobName of [
      "preflight",
      "publish-stable",
      "mirror-stable",
      "stable-docs",
      "stable-install",
      "stable-surfaces",
      "stable-cleanup",
      "next-release-base",
    ]) {
      expect(releaseResult).toContain(`- ${jobName}`);
    }
    expect(releaseResult.match(/test \"\$result\" = \"success\"/g)).toHaveLength(1);
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
    expect(docs).toContain("- mirror-stable");
    expect(docs).toContain("needs.mirror-stable.result == 'success'");
    expect(surfaces).toContain("- stable-docs");
    expect(surfaces).toContain("- stable-install");
    expect(handoff).toContain("- stable-surfaces");
    expect(handoff).toContain("- stable-cleanup");
  });

  it("fails closed when partial recovery finds different published artifacts", () => {
    const preflight = workflowJob(releaseWorkflow, "preflight");
    const npmCandidate = workflowJob(releaseWorkflow, "npm-candidate");
    const desktopCandidate = workflowJob(releaseWorkflow, "desktop-candidate");
    const candidateComplete = workflowJob(releaseWorkflow, "candidate-complete");
    const stable = workflowJob(releaseWorkflow, "publish-stable");
    const stableMirror = workflowJob(releaseWorkflow, "mirror-stable");
    expect(releaseWorkflow).toContain('description: "Original Release run ID containing the verified candidate artifacts (required for resume)"');
    expect(releaseWorkflow).toContain('candidate_run_id is required when resume_missing is true.');
    expect(releaseWorkflow).toContain("Require matching verified candidate run for recovery");
    expect(preflight).toContain("actions/runs/$CANDIDATE_RUN_ID");
    expect(preflight).not.toContain("test \"$(jq -r '.head_sha' <<< \"$run_json\")\" = \"$SOURCE_SHA\"");
    expect(preflight).toContain('test "$(jq -r \'.path\' <<< "$run_json")" = ".github/workflows/release.yml"');
    expect(preflight).toContain('test "$(jq -r \'.head_branch\' <<< "$run_json")" = "main"');
    expect(preflight).toContain('test "$(jq -r \'.head_repository.full_name\' <<< "$run_json")" = "$GITHUB_REPOSITORY"');
    expect(preflight).toContain('candidate_workflow_sha="$(jq -r \'.head_sha\' <<< "$run_json")"');
    expect(preflight).toContain('git cat-file -e "$candidate_workflow_sha^{commit}"');
    expect(preflight).toContain("git merge-base --is-ancestor \"$candidate_workflow_sha\" refs/remotes/origin/main");
    expect(preflight).toContain("success|cancelled|failure");
    expect(preflight).toContain("actions/runs/$CANDIDATE_RUN_ID/jobs?per_page=100");
    expect(preflight).toContain('.name == "Publish stable" and .conclusion == "success"');
    expect(preflight).toContain('git ls-remote --tags origin "refs/tags/$TAG"');
    expect(preflight).toContain('test "$SOURCE_SHA" = "$remote_tag_sha"');
    for (const artifact of [
      "npm-release-candidate",
      "desktop-macos-x64",
      "desktop-macos-arm64",
      "desktop-windows-x64",
      "desktop-linux-x64",
    ]) {
      expect(preflight).toContain(artifact);
    }
    expect(preflight).toContain(".artifacts | map(select(.expired == false))");
    const identityIndex = preflight.indexOf(".head_repository.full_name");
    const trustedWorkflowIndex = preflight.indexOf('git cat-file -e "$candidate_workflow_sha^{commit}"');
    const terminalIndex = preflight.indexOf("success|cancelled|failure");
    const publishIndex = preflight.indexOf('.name == "Publish stable" and .conclusion == "success"');
    const tagIndex = preflight.indexOf('git ls-remote --tags origin "refs/tags/$TAG"');
    const artifactsIndex = preflight.indexOf(".artifacts | map(select(.expired == false))");
    expect(identityIndex).toBeGreaterThan(-1);
    expect(trustedWorkflowIndex).toBeGreaterThan(identityIndex);
    expect(terminalIndex).toBeGreaterThan(trustedWorkflowIndex);
    expect(publishIndex).toBeGreaterThan(terminalIndex);
    expect(tagIndex).toBeGreaterThan(publishIndex);
    expect(artifactsIndex).toBeGreaterThan(tagIndex);
    expect(npmCandidate).toContain("if: needs.preflight.outputs.resume != 'true'");
    expect(desktopCandidate).toContain("if: needs.preflight.outputs.resume != 'true'");
    expect(candidateComplete).toContain("needs.npm-candidate.result == 'skipped'");
    expect(candidateComplete).toContain("needs.desktop-candidate.result == 'skipped'");
    expect(stable).toContain('run-id: ${{ needs.preflight.outputs.candidate_run_id }}');
    expect(stable).toContain('github-token: ${{ github.token }}');
    expect(stable).toContain('test "$RESUME_MISSING" = "true"');
    expect(stable).toContain("publish-github-release-assets-immutable.mjs");
    expect(stable).toContain("--phase binaries");
    expect(stableMirror).toContain('run-id: ${{ needs.preflight.outputs.candidate_run_id }}');
    expect(stableMirror).toContain("--allow-existing-checksum-marker");
    expect(stableMirror).toContain("--phase checksum");
    expect(stable).not.toContain("--clobber");
    expect(stableMirror).not.toContain("--clobber");
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
