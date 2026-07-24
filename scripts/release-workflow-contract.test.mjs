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

describe("release workflow latency contracts", () => {
  it("starts canaries from successful CI instead of repeating the verification matrix", () => {
    expect(releaseWorkflow).toContain("workflow_run:");
    expect(releaseWorkflow).toMatch(/workflows:\s*\[?\"?CI\"?/);
    expect(releaseWorkflow).toContain("types: [completed]");
    expect(releaseWorkflow).not.toMatch(/^  verify:/m);
    expect(releaseWorkflow).not.toContain("Unit tests");
    expect(releaseWorkflow).not.toContain("matrix.os");
  });

  it("resolves an immutable source and runs release preflight before installation", () => {
    expect(releaseWorkflow).toMatch(/^  preflight:/m);
    expect(releaseWorkflow).toContain("source_sha:");
    expect(releaseWorkflow).toContain("Require successful CI for exact source");
    expect(releaseWorkflow).toContain("./scripts/release.sh canary --preflight");
    expect(releaseWorkflow).toContain("./scripts/release.sh stable --preflight");
    expect(releaseWorkflow).toContain("Locked canary preflight");
    expect(releaseWorkflow).toContain('--expected-version "$version"');

    const preflightIndex = releaseWorkflow.indexOf("Release preflight");
    const installIndex = releaseWorkflow.indexOf("Install dependencies");
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeGreaterThan(preflightIndex);
  });

  it("keeps dry-run code read-only and fails closed when repository safeguards are missing", () => {
    const workflowPermissions = releaseWorkflow.slice(
      releaseWorkflow.indexOf("permissions:"),
      releaseWorkflow.indexOf("jobs:"),
    );
    expect(workflowPermissions).toContain("contents: read");
    expect(workflowPermissions).not.toContain("id-token: write");
    expect(releaseWorkflow).toContain("Require release repository safeguards");
    expect(releaseWorkflow).toContain("RELEASE_SAFEGUARDS_CONFIGURED");
  });

  it("serializes publication and advances the next patch base directly on main", () => {
    expect(releaseWorkflow.match(/group: release-publish/g)).toHaveLength(2);
    expect(releaseWorkflow).toMatch(/^  next-release-base:/m);
    expect(releaseWorkflow).toContain("node scripts/prepare-next-release.mjs");
    expect(releaseWorkflow).toContain("Advance main to the next patch version");
    expect(releaseWorkflow).toContain("Start CI for the advanced release base");
    expect(releaseWorkflow).toContain("outputs.action == 'updated' || steps.next-release.outputs.action == 'ready'");
    expect(releaseWorkflow).toContain('-f source_sha="${{ steps.next-release.outputs.head_sha }}"');
    expect(ciWorkflow).toContain("source_sha:");
    expect(ciWorkflow).toContain("inputs.source_sha || github.sha");
    expect(releaseWorkflow).not.toContain("pull-requests: write");
    expect(nextReleaseScript).toContain("[skip release]");
    expect(nextReleaseScript).toContain("HEAD:refs/heads/${options.base}");
    expect(nextReleaseScript).not.toContain('"pr", "create"');
    expect(releaseWorkflow).not.toContain("continue-on-error: true");
  });

  it("caches prepared Desktop PostgreSQL payloads on non-Linux runners", () => {
    expect(desktopWorkflow).toContain("Cache PostgreSQL runtime payload");
    expect(desktopWorkflow).toContain("actions/cache@");
    expect(desktopWorkflow).toContain("postgres-runtime-18.4-");
    expect(desktopWorkflow).toContain("hashFiles('desktop/scripts/prepare-postgres-runtime.mjs')");
    expect(desktopWorkflow).toContain("matrix.platform != 'linux'");
    expect(releaseWorkflow).toContain("--ref main");
    expect(releaseWorkflow).toContain('-f source_ref="$tag"');
  });

  it("does not rebuild after the local verification gate already built the workspace", () => {
    expect(releaseScript).toContain("workspace_built=true");
    expect(releaseScript).toContain("Reusing workspace build from verification gate");
  });

  it("makes the localized public changelog a separately approved stable release surface", () => {
    const stableDocsIndex = releaseWorkflow.indexOf("\n  stable-docs:\n");
    const nextReleaseIndex = releaseWorkflow.indexOf("\n  next-release-base:\n");

    expect(releaseWorkflow).toContain("confirm_docs:");
    expect(releaseWorkflow).toContain('test "$CONFIRM_DOCS" = "PUBLISH DOCS"');
    expect(releaseWorkflow).toContain("name: Publish stable changelog to docs production");
    expect(releaseWorkflow).toContain("uses: ./.github/workflows/docs-production.yml");
    expect(releaseWorkflow).toContain("source_ref: v${{ needs.stable.outputs.version }}");
    expect(releaseWorkflow).toContain("tag_name: docs/release/v${{ needs.stable.outputs.version }}");
    expect(releaseWorkflow).toContain("release_docs_approved: true");
    expect(releaseWorkflow).toContain("needs.stable-docs.result == 'success'");
    expect(stableDocsIndex).toBeGreaterThan(-1);
    expect(nextReleaseIndex).toBeGreaterThan(stableDocsIndex);
    expect(releaseScript).toContain("scripts/verify-stable-changelog.mjs");

    expect(docsProductionWorkflow).toContain("workflow_call:");
    expect(docsProductionWorkflow).toContain("release_docs_approved:");
    expect(docsProductionWorkflow).toContain("type: boolean");
    expect(docsProductionWorkflow).toContain('test "$RELEASE_DOCS_APPROVED" = "true"');
    expect(docsProductionWorkflow).toContain("^docs/release/v[0-9]+");
  });
});
