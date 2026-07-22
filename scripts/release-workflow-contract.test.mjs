import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseWorkflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
const ciWorkflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
const desktopWorkflow = readFileSync(join(repoRoot, ".github/workflows/desktop-release.yml"), "utf8");
const releaseScript = readFileSync(join(repoRoot, "scripts/release.sh"), "utf8");

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

  it("serializes canary and stable publication and proposes the next patch base", () => {
    expect(releaseWorkflow.match(/group: release-publish/g)).toHaveLength(2);
    expect(releaseWorkflow).toMatch(/^  next-release-base:/m);
    expect(releaseWorkflow).toContain("node scripts/prepare-next-release.mjs");
    expect(releaseWorkflow).toContain("Start CI for next release base");
    expect(releaseWorkflow).toContain('-f source_sha="${{ steps.next-release.outputs.head_sha }}"');
    expect(ciWorkflow).toContain("source_sha:");
    expect(ciWorkflow).toContain("inputs.source_sha || github.sha");
    expect(releaseWorkflow).toContain("pull-requests: write");
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
});
