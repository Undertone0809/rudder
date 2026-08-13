import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseWorkflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
const docsProductionWorkflow = readFileSync(
  join(repoRoot, ".github/workflows/docs-production.yml"),
  "utf8",
);
const ciWorkflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
const desktopWorkflow = readFileSync(join(repoRoot, ".github/workflows/desktop-release.yml"), "utf8");
const releaseScript = readFileSync(join(repoRoot, "scripts/release.sh"), "utf8");
const nextReleaseScript = readFileSync(join(repoRoot, "scripts/prepare-next-release.mjs"), "utf8");

function workflowJob(source, jobName) {
  const start = source.indexOf(`\n  ${jobName}:\n`);
  if (start === -1) throw new Error(`Workflow job not found: ${jobName}`);
  const remaining = source.slice(start + 1);
  const next = remaining.slice(1).search(/^  [a-zA-Z0-9_-]+:\n/m);
  return next === -1 ? source.slice(start) : source.slice(start, start + next + 2);
}

describe("release workflow latency contracts", () => {
  it("starts canaries from successful CI instead of repeating the verification matrix", () => {
    expect(releaseWorkflow).toContain("workflow_run:");
    expect(releaseWorkflow).toMatch(/workflows:\s*\[?\"?CI\"?/);
    expect(releaseWorkflow).toContain("types: [completed]");
    expect(releaseWorkflow).not.toMatch(/^  verify:/m);
    expect(releaseWorkflow).not.toContain("Unit tests");
  });

  it("resolves an immutable source and runs release preflight before installation", () => {
    expect(releaseWorkflow).toMatch(/^  preflight:/m);
    expect(releaseWorkflow).toContain("source_sha:");
    expect(releaseWorkflow).toContain('description: "Full commit SHA to promote as stable"');
    expect(releaseWorkflow).not.toContain('default: "main"');
    expect(releaseWorkflow).toContain("Require immutable stable source SHA");
    expect(releaseWorkflow).toContain('^[0-9a-f]{40}$');
    expect(releaseWorkflow).toContain("Require release source from main history");
    expect(releaseWorkflow).toContain('git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main');
    expect(releaseWorkflow).toContain("Require successful CI for exact source");
    expect(releaseWorkflow).toContain('-f head_sha="$SOURCE_SHA"');
    expect(releaseWorkflow).toContain("-f status=success");
    expect(releaseWorkflow).toContain(
      'select((.event == "push" and .head_branch == "main") or .event == "workflow_dispatch")',
    );
    expect(ciWorkflow).toContain("Require dispatch ref to match exact source");
    expect(ciWorkflow).toContain('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"');
    expect(ciWorkflow).toContain('test "$DISPATCH_REF_SHA" = "$SOURCE_SHA"');
    expect(releaseWorkflow).toContain(
      "if: github.event_name == 'workflow_dispatch' && !inputs.dry_run && !inputs.resume_missing && github.repository == 'Undertone0809/rudder'",
    );
    expect(releaseWorkflow).toContain("environment: npm-stable");
    expect(releaseWorkflow).toContain("./scripts/release.sh canary --preflight");
    expect(releaseWorkflow).toContain("./scripts/release.sh stable --preflight");
    expect(releaseWorkflow).toContain("Locked canary preflight");
    expect(releaseWorkflow).toContain('--expected-version "$version"');

    const preflightIndex = releaseWorkflow.indexOf("Release preflight");
    const installIndex = releaseWorkflow.indexOf("Install dependencies");
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeGreaterThan(preflightIndex);
  });

  it("retries transient dependency installation failures in every verification lane", () => {
    const docsJob = workflowJob(ciWorkflow, "docs");
    const verifyJob = workflowJob(ciWorkflow, "verify");

    expect(docsJob).toContain("for attempt in 1 2 3");
    expect(verifyJob).toContain("if: matrix.test == 'full'");
    expect(verifyJob).toContain("if: matrix.test != 'full'");
    expect(verifyJob.match(/for attempt in 1 2 3/g)).toHaveLength(2);
    expect(ciWorkflow.match(/pnpm install --frozen-lockfile/g)).toHaveLength(3);
    expect(ciWorkflow.match(/sleep \$\(\(attempt \* 10\)\)/g)).toHaveLength(3);
  });

  it("deduplicates automatic canary and stable work for the same locked source", () => {
    expect(releaseWorkflow).toContain(
      "group: release-source-${{ github.event_name == 'workflow_dispatch' && inputs.source_ref || github.event.workflow_run.head_sha }}",
    );
    expect(releaseWorkflow).toContain(
      "cancel-in-progress: ${{ github.event_name == 'workflow_dispatch' && !inputs.dry_run }}",
    );
  });

  it("resumes partial stable releases from the locked source version", () => {
    const resumeJob = workflowJob(releaseWorkflow, "resume-stable");
    const stableDesktopJob = workflowJob(releaseWorkflow, "stable-desktop");
    const cleanupJob = workflowJob(releaseWorkflow, "stable-canary-cleanup");

    expect(resumeJob).toContain("Require locked stable source");
    expect(resumeJob).toContain("needs: preflight");
    expect(resumeJob).toContain("group: release-publish");
    expect(resumeJob).toContain('echo "RELEASE_VERSION=$version" >> "$GITHUB_ENV"');
    expect(resumeJob).toContain('set-publish-version "$RELEASE_VERSION"');
    expect(resumeJob).toContain('test "$(wc -l < "$package_map" | xargs)" = "15"');
    expect(resumeJob).toContain('echo "Skipping existing $pkg_name@$pkg_version"');
    expect(resumeJob).toContain("npm publish --tag latest");
    expect(resumeJob).toContain("wait_for_npm_package_versions");
    expect(resumeJob).toContain("publish completed but npm never exposed");
    expect(resumeJob).toContain('tag="v${RELEASE_VERSION}"');
    expect(resumeJob).toContain('test "$remote_tag_sha" = "$SOURCE_REF"');
    expect(resumeJob).not.toContain("Wait for desktop release assets");
    expect(resumeJob).not.toContain("Clean up obsolete canary releases");
    expect(stableDesktopJob).toContain("- resume-stable");
    expect(cleanupJob).toContain("- resume-stable");
    expect(cleanupJob).toContain("- stable-desktop");
    expect(releaseWorkflow).toContain("needs.resume-stable.result == 'success'");
    expect(releaseWorkflow).toContain("needs.resume-stable.outputs.version");
    expect(resumeJob).not.toContain("v0.7.2");
    expect(resumeJob).not.toContain('set-publish-version 0.7.2');
  });

  it("keeps publication behind the immutable-source preflight without the legacy upgrade gate", () => {
    const canaryJob = workflowJob(releaseWorkflow, "canary");
    const canaryDesktopJob = workflowJob(releaseWorkflow, "canary-desktop");
    const stableJob = workflowJob(releaseWorkflow, "stable");
    const stableDesktopJob = workflowJob(releaseWorkflow, "stable-desktop");

    expect(releaseWorkflow).not.toContain("prepublish-upgrade-gate");
    expect(releaseWorkflow).not.toContain("release-compatibility-matrix.mjs");
    expect(releaseWorkflow).not.toContain("continue-on-error: true");
    expect(canaryJob).toMatch(/canary:\n[\s\S]*needs: preflight/);
    expect(stableJob).toMatch(/stable:\n[\s\S]*needs: preflight/);

    const canaryPreflightIndex = canaryJob.indexOf("Locked canary preflight");
    const canaryPublishIndex = canaryJob.indexOf("\n      - name: Publish canary\n");
    const canaryDesktopIndex = canaryJob.indexOf("\n      - name: Start desktop release build\n");
    expect(canaryPreflightIndex).toBeGreaterThan(-1);
    expect(canaryPublishIndex).toBeGreaterThan(canaryPreflightIndex);
    expect(canaryDesktopIndex).toBeGreaterThan(canaryPublishIndex);
    expect(canaryJob).not.toContain("Wait for desktop release assets");
    expect(canaryDesktopJob).toContain("Wait for desktop release assets");
    expect(canaryDesktopJob).toContain("- canary");

    const stableCheckoutIndex = stableJob.indexOf("ref: ${{ needs.preflight.outputs.source_sha }}");
    const stablePublishIndex = stableJob.indexOf("\n      - name: Publish stable\n");
    const stableDesktopIndex = stableJob.indexOf("\n      - name: Start desktop release build\n");
    expect(stableCheckoutIndex).toBeGreaterThan(-1);
    expect(stablePublishIndex).toBeGreaterThan(stableCheckoutIndex);
    expect(stableDesktopIndex).toBeGreaterThan(stablePublishIndex);
    expect(stableJob).not.toContain("Wait for desktop release assets");
    expect(stableDesktopJob).toContain("Wait for desktop release assets");
    expect(stableDesktopJob).toContain("- stable");
    expect(stableDesktopJob).toContain("- resume-stable");
  });

  it("qualifies docs once in exact-source CI instead of repeating it during stable publication", () => {
    const docsJob = workflowJob(ciWorkflow, "docs");
    const stableJob = workflowJob(releaseWorkflow, "stable");
    const docsStructureIndex = docsJob.indexOf("\n      - name: Docs structure\n");
    const playwrightIndex = docsJob.indexOf("\n      - name: Install Playwright Chromium\n");
    const docsSearchIndex = docsJob.indexOf("\n      - name: Docs search E2E\n");

    expect(docsStructureIndex).toBeGreaterThan(-1);
    expect(playwrightIndex).toBeGreaterThan(docsStructureIndex);
    expect(docsSearchIndex).toBeGreaterThan(playwrightIndex);
    expect(stableJob).not.toContain("Docs structure");
    expect(stableJob).not.toContain("Install Playwright Chromium");
    expect(stableJob).not.toContain("Docs search E2E");
    expect(ciWorkflow).not.toContain("Typecheck");
    expect(ciWorkflow).not.toContain("Core work-loop smoke");
    expect(ciWorkflow).not.toContain("pnpm test:smoke");
    expect(ciWorkflow).toContain("pnpm test:run --maxWorkers=2");
    expect(ciWorkflow).toMatch(/os: ubuntu-latest\n\s+test: full/);
    expect(ciWorkflow).toMatch(/os: macos-latest\n\s+test: build/);
  });

  it("keeps dry-run code read-only without repository-authorization attestations", () => {
    const workflowPermissions = releaseWorkflow.slice(
      releaseWorkflow.indexOf("permissions:"),
      releaseWorkflow.indexOf("jobs:"),
    );
    expect(workflowPermissions).toContain("contents: read");
    expect(workflowPermissions).not.toContain("id-token: write");
    expect(releaseWorkflow).not.toContain("Require release repository safeguards");
    expect(releaseWorkflow).not.toContain("RELEASE_SAFEGUARDS_CONFIGURED");
    expect(releaseWorkflow).not.toContain("STABLE_RELEASE_MODE");
    expect(releaseWorkflow).not.toContain("confirm_stable");
    expect(releaseWorkflow).not.toContain("confirm_docs");
  });

  it("serializes publication and advances the next patch base directly", () => {
    expect(releaseWorkflow.match(/group: release-publish/g)).toHaveLength(4);
    expect(releaseWorkflow).toMatch(/^  next-release-base:/m);
    expect(releaseWorkflow).toContain("node scripts/prepare-next-release.mjs");
    expect(releaseWorkflow).toContain("Advance main to the next patch version");
    expect(releaseWorkflow).toContain("Start CI for the advanced release base");
    expect(releaseWorkflow).toContain("outputs.action == 'updated'");
    expect(releaseWorkflow).toContain('-f source_sha="${{ steps.next-release.outputs.head_sha }}"');
    expect(ciWorkflow).toContain("source_sha:");
    expect(ciWorkflow).toContain("inputs.source_sha || github.sha");
    expect(releaseWorkflow).not.toContain("pull-requests: write");
    expect(releaseWorkflow).not.toContain("gh pr create");
    expect(nextReleaseScript).toContain("[skip release]");
    expect(nextReleaseScript).toContain("HEAD:refs/heads/${options.base}");
    expect(releaseWorkflow).not.toContain("continue-on-error: true");
  });

  it("releases the publish lock before slow Desktop work and converges every stable surface", () => {
    const canaryJob = workflowJob(releaseWorkflow, "canary");
    const promoteJob = workflowJob(releaseWorkflow, "canary-promote-latest");
    const stableJob = workflowJob(releaseWorkflow, "stable");
    const stableDesktopJob = workflowJob(releaseWorkflow, "stable-desktop");
    const stableDocsJob = workflowJob(releaseWorkflow, "stable-docs");
    const stableInstallJob = workflowJob(releaseWorkflow, "stable-public-install");
    const cleanupJob = workflowJob(releaseWorkflow, "stable-canary-cleanup");
    const nextReleaseJob = workflowJob(releaseWorkflow, "next-release-base");

    expect(canaryJob).toContain("group: release-publish");
    expect(canaryJob).not.toContain("Wait for desktop release assets");
    expect(promoteJob).toContain("group: release-publish");
    expect(promoteJob).toContain("- canary-desktop");
    expect(stableJob).toContain("group: release-publish");
    expect(stableJob).not.toContain("Wait for desktop release assets");
    expect(stableDesktopJob).not.toContain("group: release-publish");
    expect(stableDocsJob).toContain("- stable");
    expect(stableDocsJob).toContain("- resume-stable");
    expect(stableDocsJob).not.toContain("- stable-desktop");
    expect(stableInstallJob).toContain("- stable-desktop");
    expect(cleanupJob).toContain("- stable-desktop");
    expect(nextReleaseJob).toContain("- stable-desktop");
    expect(nextReleaseJob).toContain("- stable-docs");
    expect(nextReleaseJob).toContain("- stable-public-install");
    expect(nextReleaseJob).toContain("- stable-canary-cleanup");
    expect(nextReleaseJob).toContain("needs.stable-desktop.result == 'success'");
    expect(nextReleaseJob).toContain("needs.stable-docs.result == 'success'");
    expect(nextReleaseJob).toContain("needs.stable-public-install.result == 'success'");
    expect(nextReleaseJob).toContain("needs.stable-canary-cleanup.result == 'success'");
  });

  it("caches dependency and browser downloads in CI, publish, and Desktop jobs", () => {
    const releaseJobsWithInstalls = ["resume-stable", "canary", "stable-dry-run", "stable"];
    expect(workflowJob(ciWorkflow, "docs")).toContain("Cache Playwright Chromium");
    expect(workflowJob(ciWorkflow, "verify")).toContain("Cache pnpm store");
    for (const jobName of releaseJobsWithInstalls) {
      expect(workflowJob(releaseWorkflow, jobName)).toContain("Cache pnpm store");
    }
    expect(desktopWorkflow).toContain("Cache pnpm store");
    expect(desktopWorkflow).toContain("Cache Playwright Chromium");
  });

  it("caches prepared Desktop PostgreSQL payloads and builds a relocatable Linux runtime", () => {
    expect(desktopWorkflow).toContain("Cache PostgreSQL runtime payload");
    expect(desktopWorkflow).toContain("actions/cache@");
    expect(desktopWorkflow).toContain("postgres-runtime-18.4-");
    expect(desktopWorkflow).toContain("hashFiles('desktop/scripts/prepare-postgres-runtime.mjs', '.github/workflows/desktop-release.yml')");
    expect(desktopWorkflow).toContain("https://ftp.postgresql.org/pub/source/v18.4/postgresql-18.4.tar.bz2");
    expect(desktopWorkflow).toContain("81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094");
    expect(desktopWorkflow).toContain("--without-icu");
    expect(desktopWorkflow).toContain("--without-readline");
    expect(desktopWorkflow).toContain("--without-zlib");
    expect(desktopWorkflow).toContain("Linux portable PostgreSQL must bundle its own timezone database.");
    expect(desktopWorkflow).toContain("source_runtime}.portable-smoke-hidden");
    expect(desktopWorkflow).toContain(
      'if [ "$(uname -s)" = "Linux" ] || [ "$(uname -s)" = "Darwin" ]; then',
    );
    expect(desktopWorkflow).toContain('staged_runtime}/bin/initdb');
    expect(desktopWorkflow).toContain('staged_runtime}/bin/pg_ctl');
    expect(desktopWorkflow).not.toContain("sudo apt-get install -y postgresql-18");
    expect(releaseWorkflow).toContain("--ref main");
    expect(releaseWorkflow).toContain('-f source_ref="$tag"');
  });

  it("installs the Playwright browser required by the packaged app-builder smoke", () => {
    const appBuilderSmokeIndex = desktopWorkflow.indexOf(
      "\n      - name: Smoke packaged App Builder\n",
    );
    const postgresSmokeIndex = desktopWorkflow.indexOf(
      "\n      - name: Smoke staged PostgreSQL runtime\n",
    );
    expect(appBuilderSmokeIndex).toBeGreaterThan(-1);
    expect(postgresSmokeIndex).toBeGreaterThan(appBuilderSmokeIndex);
    const appBuilderSmoke = desktopWorkflow.slice(
      appBuilderSmokeIndex,
      postgresSmokeIndex,
    );

    expect(desktopWorkflow).toContain("Install Playwright Chromium");
    expect(desktopWorkflow).toMatch(/- name: Install Playwright Chromium\n\s+if: matrix\.platform != 'windows'/);
    expect(desktopWorkflow).toContain("pnpm exec playwright install --with-deps chromium");
    expect(desktopWorkflow).toContain("pnpm exec playwright install chromium");
    expect(appBuilderSmoke).toContain("if: matrix.platform != 'windows'");
    expect(appBuilderSmoke).toContain("node desktop/scripts/app-builder-smoke.mjs --packaged");

    const installIndex = desktopWorkflow.indexOf("Install Playwright Chromium");
    const smokeIndex = desktopWorkflow.indexOf(
      "node desktop/scripts/app-builder-smoke.mjs --packaged",
    );
    expect(installIndex).toBeGreaterThan(-1);
    expect(smokeIndex).toBeGreaterThan(installIndex);
  });

  it("opens the packaged macOS account gate before publishing Desktop artifacts", () => {
    expect(desktopWorkflow).not.toContain("--scenario=upgrade");
    expect(desktopWorkflow).toContain("matrix.platform == 'macos' && matrix.arch == 'arm64'");
    expect(desktopWorkflow).toContain(
      "node desktop/scripts/smoke.mjs --mode=packaged --scenario=account-gate",
    );

    const smokeIndex = desktopWorkflow.indexOf(
      "node desktop/scripts/smoke.mjs --mode=packaged --scenario=account-gate",
    );
    const collectIndex = desktopWorkflow.indexOf("node scripts/collect-desktop-release-assets.mjs");
    expect(smokeIndex).toBeGreaterThan(-1);
    expect(collectIndex).toBeGreaterThan(smokeIndex);
  });

  it("does not rebuild after the local verification gate already built the workspace", () => {
    expect(releaseScript).toContain("workspace_built=true");
    expect(releaseScript).toContain("Reusing workspace build from verification gate");
  });

  it("keeps the localized public changelog in the stable release machine gate", () => {
    const stableDocsIndex = releaseWorkflow.indexOf("\n  stable-docs:\n");
    const nextReleaseIndex = releaseWorkflow.indexOf("\n  next-release-base:\n");

    expect(releaseWorkflow).not.toContain("confirm_docs:");
    expect(releaseWorkflow).not.toContain('test "$CONFIRM_DOCS" = "PUBLISH DOCS"');
    expect(releaseWorkflow).toContain("name: Publish stable changelog to docs production");
    expect(releaseWorkflow).toContain("uses: ./.github/workflows/docs-production.yml");
    expect(releaseWorkflow).toContain(
      "source_ref: v${{ needs.stable.outputs.version || needs.resume-stable.outputs.version }}",
    );
    expect(releaseWorkflow).toContain(
      "tag_name: docs/release/v${{ needs.stable.outputs.version || needs.resume-stable.outputs.version }}",
    );
    expect(releaseWorkflow).toContain("release_docs_approved: true");
    expect(releaseWorkflow).toContain("needs.stable-docs.result == 'success'");
    expect(stableDocsIndex).toBeGreaterThan(-1);
    expect(nextReleaseIndex).toBeGreaterThan(stableDocsIndex);
    expect(releaseScript).toContain("scripts/verify-stable-changelog.mjs");

    expect(docsProductionWorkflow).toContain("workflow_call:");
    expect(docsProductionWorkflow).toContain("release_docs_approved:");
    expect(docsProductionWorkflow).toContain('if [ "$RELEASE_DOCS_APPROVED" = "true" ]; then');
    expect(docsProductionWorkflow).not.toContain('if [ "$GITHUB_EVENT_NAME" = "workflow_call" ]; then');
    expect(docsProductionWorkflow).toContain("type: boolean");
    expect(docsProductionWorkflow).toContain('test "$CONFIRM_DOMAIN" = "$DOCS_PRODUCTION_DOMAIN"');
    expect(docsProductionWorkflow).toContain("^docs/release/v[0-9]+");
  });
});
