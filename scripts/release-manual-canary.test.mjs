import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
const roots = [];
const sourceSha = "a".repeat(40);

function job(name) {
  const rest = workflow.slice(workflow.indexOf(`\n  ${name}:\n`) + 1);
  if (!rest.startsWith(`  ${name}:\n`)) throw new Error(`Missing job ${name}`);
  return rest.split(/\n(?=  [\w-]+:\n)/)[0];
}

function step(name) {
  const rest = workflow.slice(workflow.indexOf(`      - name: ${name}\n`));
  if (!rest.startsWith(`      - name: ${name}\n`)) throw new Error(`Missing step ${name}`);
  return rest.split(/\n(?=      - |  [\w-]+:\n)/)[0];
}

function script(name) {
  const value = step(name).split(/\n        run: /)[1];
  if (!value) throw new Error(`Missing run script ${name}`);
  return value.startsWith("|\n")
    ? value.slice(2).split("\n").map((line) => line.replace(/^          /, "")).join("\n")
    : value.trim();
}

function runScript(name, env = {}, cwd = root) {
  return spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", script(name)
    .replaceAll("${{ steps.source.outputs.sha }}", env.SOURCE_REF ?? sourceSha)], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function validate(env = {}) {
  return runScript("Validate manual release channel", {
    RELEASE_CHANNEL: "canary",
    DRY_RUN: "true",
    RESUME_MISSING: "false",
    CANDIDATE_RUN_ID: "",
    MIRROR_RECOVERY: "false",
    RECOVERY_TAG: "",
    MIRROR_COS: "false",
    ...env,
  });
}

function condition(name, github, needs = {}) {
  const match = job(name).match(/^    if: (.+)(?:\n((?:      .+\n)*))?/m);
  const dependencies = [...(job(name).match(/^    needs:\n((?:      - [\w-]+\n)+)/m)?.[1] ?? "").matchAll(/- ([\w-]+)/g)]
    .map((item) => item[1]);
  const dependenciesSucceeded = dependencies.every((dependency) => needs[dependency]?.result === "success");
  if (!match) return dependenciesSucceeded;
  const expression = match[1] === ">-" ? match[2].trim() : match[1];
  const explicitStatus = /\b(always|success|failure|cancelled)\(/.test(expression);
  if (!explicitStatus && !dependenciesSucceeded) return false;
  const resolved = expression.replace(/\b(?:github|needs)(?:\.[\w-]+)+/g, (path) => {
    const parts = path.split(".");
    let value = { github, needs };
    for (const part of parts) value = value?.[part];
    // Actions string equality and contains comparisons are case-insensitive.
    return JSON.stringify(typeof value === "string" ? value.toLowerCase() : value ?? "");
  });
  return Boolean(Function("always", "contains", `return (${resolved});`)(
    () => true, (value, part) => value.includes(part),
  ));
}

function dispatch(inputs = {}) {
  return {
    event_name: "workflow_dispatch",
    repository: "owner/rudder",
    event: { inputs: { release_channel: "canary", dry_run: "false", mirror_recovery: "false", ...inputs } },
  };
}

function candidateNeeds(outputs = {}) {
  return {
    preflight: { result: "success", outputs: { channel: "canary", publish: "true", mirror_cos: "false", ...outputs } },
    "candidate-complete": { result: "success" },
    "candidate-verify": { result: "success" },
  };
}

function identityFixture(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rudder-manual-canary-"));
  roots.push(dir);
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "cli"));
  mkdirSync(join(dir, "releases"));
  cpSync(join(root, "scripts/release-mirror-policy.mjs"), join(dir, "scripts/release-mirror-policy.mjs"));
  writeFileSync(join(dir, "cli/package.json"), JSON.stringify({ version: "0.7.24" }));
  writeFileSync(join(dir, "releases/v0.7.24.md"), "Stable notes fixture\n");
  writeFileSync(join(dir, "scripts/release.sh"), `#!/usr/bin/env bash
set -euo pipefail
test "$2" = "--preflight"
echo "$* $(git rev-parse HEAD)" >> "$PREFLIGHT_LOG"
if [ "$1" = "canary" ]; then
  test "$(git branch --show-current)" = "main"
  echo "0.7.24-canary.21"
else
  echo "0.7.24"
fi
`, { mode: 0o755 });
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Workflow test");
  git("config", "user.email", "workflow-test@example.invalid");
  git("add", ".");
  git("commit", "-m", "Frozen qualified source");
  const frozen = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "later.txt"), "Later unrelated main work\n");
  git("add", ".");
  git("commit", "-m", "Main advanced");
  const advanced = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", advanced);
  git("checkout", "--detach", frozen);
  const result = runScript("Resolve release identity", {
    EVENT_NAME: "workflow_dispatch", RELEASE_CHANNEL: "canary", DRY_RUN: "false",
    RESUME_MISSING: "false", CANDIDATE_RUN_ID: "", MIRROR_COS: "false", SKIP_MIRROR: "false",
    GITHUB_RUN_ID: "12345", GITHUB_OUTPUT: join(dir, "output"), PREFLIGHT_LOG: join(dir, "preflight.log"),
    SOURCE_REF: frozen, ...env,
  }, dir);
  return {
    ...result, dir, git, frozen, advanced,
    outputs: result.status === 0
      ? Object.fromEntries(readFileSync(join(dir, "output"), "utf8").trim().split("\n").map((line) => line.split("=")))
      : {},
  };
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("manual canary dispatch", () => {
  it("makes stable the compatible default and canary an explicit choice", () => {
    expect(workflow).toMatch(/release_channel:\n\s+description: .+\n\s+required: true\n\s+type: choice\n\s+default: stable\n\s+options:\n\s+- stable\n\s+- canary/);
    for (const channel of ["", "stable", "canary"]) expect(validate({ RELEASE_CHANNEL: channel }).status).toBe(0);
    for (const channel of ["CANARY", "beta", " stable", "canary\nstable"]) {
      const result = validate({ RELEASE_CHANNEL: channel });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("release_channel must be stable or canary");
    }
  });

  it.each([
    { RESUME_MISSING: "true" }, { CANDIDATE_RUN_ID: "12345" }, { CANDIDATE_RUN_ID: "invalid" },
    { MIRROR_RECOVERY: "true" }, { RECOVERY_TAG: "v0.7.24" }, { MIRROR_COS: "true" }, { DRY_RUN: "invalid" },
  ])("rejects unsupported canary inputs before any checkout or preflight: %j", (env) => {
    expect(validate(env).status).not.toBe(0);
    expect(job("preflight").indexOf("Validate manual release channel"))
      .toBeLessThan(job("preflight").indexOf("uses: actions/checkout"));
  });

  it("cannot use mirror recovery to bypass canary or malformed-channel validation", () => {
    for (const channel of ["canary", "bad-channel"]) {
      const context = dispatch({ release_channel: channel, mirror_recovery: "true" });
      expect(condition("preflight", context)).toBe(true);
      expect(condition("mirror-recovery", context)).toBe(false);
      expect(validate({ RELEASE_CHANNEL: channel, MIRROR_RECOVERY: "true" }).status).not.toBe(0);
    }
    for (const channel of ["", "stable"]) {
      const context = dispatch({ release_channel: channel, mirror_recovery: "true" });
      expect(condition("preflight", context)).toBe(false);
      expect(condition("mirror-recovery", context)).toBe(true);
    }
  });

  it("rejects malformed stable recovery even with case-insensitive Actions routing", () => {
    const context = dispatch({ release_channel: "STABLE", mirror_recovery: "true" });
    expect(condition("preflight", context)).toBe(false);
    expect(condition("mirror-recovery", context)).toBe(true);
    expect(runScript("Require stable recovery channel", { RELEASE_CHANNEL: "STABLE" }).status).not.toBe(0);
    for (const channel of ["", "stable"]) {
      expect(runScript("Require stable recovery channel", { RELEASE_CHANNEL: channel }).status).toBe(0);
    }
    expect(job("mirror-recovery").indexOf("Require stable recovery channel"))
      .toBeLessThan(job("mirror-recovery").indexOf("uses: actions/checkout"));
  });

  it("requires a full immutable SHA and the workflow main ref", () => {
    for (const source of ["main", "v0.7.24", "a".repeat(7), "a".repeat(39), "a".repeat(41), "g".repeat(40), ""]) {
      expect(runScript("Require immutable release source SHA", { SOURCE_REF: source }).status).not.toBe(0);
    }
    expect(runScript("Require immutable release source SHA", { SOURCE_REF: sourceSha }).status).toBe(0);
    for (const ref of ["refs/heads/feature", "refs/tags/v0.7.24", ""]) {
      expect(runScript("Require release workflow dispatch from main", { GITHUB_REF: ref }).status).not.toBe(0);
    }
    expect(runScript("Require release workflow dispatch from main", { GITHUB_REF: "refs/heads/main" }).status).toBe(0);
    expect(script("Require release source from main history")).toContain('git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main');
  });

  it.each(["false", "true", ""])("locks canary preflight to the original source with dry_run=%s", (dryRun) => {
    const result = identityFixture({ DRY_RUN: dryRun });
    expect(result.status, result.stderr).toBe(0);
    expect(result.git("branch", "--show-current")).toBe("main");
    expect(result.git("rev-parse", "HEAD")).toBe(result.frozen);
    expect(result.git("rev-parse", "refs/remotes/origin/main")).toBe(result.advanced);
    expect(readFileSync(join(result.dir, "preflight.log"), "utf8")).toBe(`canary --preflight ${result.frozen}\n`);
    expect(result.outputs).toEqual({
      channel: "canary", version: "0.7.24-canary.21", tag: "canary/v0.7.24-canary.21",
      publish: dryRun === "false" ? "true" : "false", resume: "false", candidate_run_id: "12345",
      candidate_external: "false", mirror_cos: "false",
    });
  });

  it.each(["", "stable"])("preserves stable identity and publishing for channel=%s", (channel) => {
    const result = identityFixture({ RELEASE_CHANNEL: channel });
    expect(result.status, result.stderr).toBe(0);
    expect(result.outputs).toMatchObject({ channel: "stable", version: "0.7.24", tag: "v0.7.24", publish: "true" });
    const needs = candidateNeeds({ channel: "stable" });
    expect(condition("publish-stable", dispatch({ release_channel: channel }), needs)).toBe(true);
    expect(condition("stable-release-result", dispatch({ release_channel: channel }), needs)).toBe(true);
    expect(condition("publish-canary", dispatch({ release_channel: channel }), needs)).toBe(false);
  });

  it("preserves stable candidate reuse and resume inputs", () => {
    const result = identityFixture({ RELEASE_CHANNEL: "stable", RESUME_MISSING: "true", CANDIDATE_RUN_ID: "67890" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.outputs).toMatchObject({ channel: "stable", resume: "true", candidate_external: "true", candidate_run_id: "67890" });
  });

  it("does not route a real manual canary through stable publication or its terminal gate", () => {
    const context = dispatch();
    const needs = candidateNeeds();
    expect(condition("publish-canary", context, needs)).toBe(true);
    expect(condition("publish-stable", context, needs)).toBe(false);
    expect(condition("stable-release-result", context, needs)).toBe(false);
    expect(condition("canary-release-result", context, needs)).toBe(true);
    const skipped = { ...needs, "publish-stable": { result: "skipped" }, "mirror-stable": { result: "skipped" },
      "checksum-stable": { result: "skipped" }, "stable-docs": { result: "skipped" },
      "stable-install": { result: "skipped" }, "stable-surfaces": { result: "skipped" }, "stable-cleanup": { result: "skipped" } };
    for (const name of ["mirror-stable", "checksum-stable", "stable-docs", "stable-install", "stable-surfaces", "stable-cleanup", "next-release-base"]) {
      expect(condition(name, context, skipped), name).toBe(false);
    }
  });

  it.each(["canary", "stable", ""])("keeps every downstream mutation skipped for dry-run channel=%s", (channel) => {
    const context = dispatch({ release_channel: channel, dry_run: "true" });
    const needs = {
      ...candidateNeeds({ channel: channel || "stable", publish: "false" }),
      "publish-canary": { result: "skipped" }, "publish-stable": { result: "skipped" },
      "mirror-canary": { result: "skipped" }, "mirror-stable": { result: "skipped" },
      "checksum-canary": { result: "skipped" }, "checksum-stable": { result: "skipped" },
      "canary-install": { result: "skipped" }, "stable-install": { result: "skipped" },
      "stable-docs": { result: "skipped" }, "stable-surfaces": { result: "skipped" }, "stable-cleanup": { result: "skipped" },
    };
    for (const name of ["publish-canary", "publish-stable", "mirror-recovery", "mirror-canary", "mirror-stable", "checksum-canary", "checksum-stable", "canary-promote-latest", "stable-docs", "stable-cleanup", "next-release-base"]) {
      expect(condition(name, context, needs), name).toBe(false);
    }
    expect(job("npm-candidate")).not.toContain("needs.preflight.outputs.publish");
    expect(job("desktop-candidate")).not.toContain("needs.preflight.outputs.publish");
  });

  it("preserves automatic canary trigger, source guards, and publication behavior", () => {
    const context = { event_name: "workflow_run", repository: "owner/rudder", event: {
      workflow_run: { conclusion: "success", event: "push", head_branch: "main", repository: { full_name: "owner/rudder" }, head_commit: { message: "Feature" } },
    } };
    expect(condition("preflight", context)).toBe(true);
    for (const patch of [{ conclusion: "failure" }, { event: "pull_request" }, { head_branch: "feature" }, { repository: { full_name: "fork/rudder" } }, { head_commit: { message: "Repair [skip release]" } }]) {
      expect(condition("preflight", { ...context, event: { workflow_run: { ...context.event.workflow_run, ...patch } } })).toBe(false);
    }
    const result = identityFixture({ EVENT_NAME: "workflow_run", RELEASE_CHANNEL: "", DRY_RUN: "true", MIRROR_COS: "true" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.outputs).toMatchObject({ channel: "canary", publish: "true", resume: "false", mirror_cos: "false" });
    expect(condition("publish-canary", context, candidateNeeds())).toBe(true);
    expect(condition("canary-release-result", context, candidateNeeds())).toBe(false);
    expect(job("canary-promote-latest")).toContain("--only-if-no-stable");
  });

  it("keeps exact full Test, six unexpired foundations, and immutable manifest verification shared", () => {
    const qualify = script("Resolve exact successful Test qualification");
    const receipt = script("Require exact aggregate qualification receipt");
    expect(qualify).toContain('-f head_sha="$SOURCE_SHA"');
    for (const gate of ["Qualification summary", "plan.sourceSha !== sourceSha", "plan.sourceTreeSha !== sourceTreeSha", "planDigest !== expectedDigest", 'plan.qualification !== "full"', "plan.fullQualification !== true", ".expired == false"]) {
      expect(receipt).toContain(gate);
    }
    for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu", "aarch64-pc-windows-msvc", "x86_64-pc-windows-msvc"]) expect(receipt).toContain(target);
    expect(job("candidate-verify")).toContain("--workflow-source-sha");
    const publish = job("publish-canary");
    expect(publish.indexOf("Verify candidate before canary publication")).toBeLessThan(publish.indexOf("npm publish"));
    expect(publish).toContain("--tag canary --access public --provenance");
    expect(publish).toContain('git tag "$RELEASE_TAG" "$SOURCE_SHA"');
    expect(job("canary-install")).toContain("needs.checksum-canary.result == 'success'");
    for (const platform of ["Linux x64", "Windows x64", "macOS arm64"]) expect(job("canary-install")).toContain(platform);
  });
});

function terminalEnv(dryRun = "false") {
  return {
    DRY_RUN: dryRun, PREFLIGHT_RESULT: "success", NPM_CANDIDATE_RESULT: "success", DESKTOP_CANDIDATE_RESULT: "success",
    COMPLETE_RESULT: "success", VERIFY_RESULT: "success", MIRROR_RESULT: "skipped",
    ...Object.fromEntries(["PUBLISH_RESULT", "CHECKSUM_RESULT", "INSTALL_RESULT", "PROMOTE_RESULT"].map((key) => [key, dryRun === "false" ? "success" : "skipped"])),
  };
}

function publicSurfaceFixture(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rudder-canary-surfaces-"));
  roots.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const command = (name, body) => writeFileSync(join(bin, name), `#!/usr/bin/env bash
set -euo pipefail
echo "${name} $*" >> "$COMMAND_LOG"
${body}
`, { mode: 0o755 });
  command("node", `case "$1" in
  scripts/wait-for-desktop-release-assets.mjs) exit "\${ASSET_STATUS:-0}" ;;
  scripts/release-package-map.mjs)
    for ((i=1; i<=\${PACKAGE_COUNT:-14}; i++)); do
      printf 'package-%s\\t@rudderhq/package-%s\\t0.7.24\\n' "$i" "$i"
    done ;;
  *) exit 90 ;;
esac`);
  command("git", `test "$1 $2" = "ls-remote --tags"
printf '%s\\t%s\\n' "\${TAG_SHA:-$SOURCE_SHA}" "refs/tags/$RELEASE_TAG"`);
  command("gh", `test "$1 $2" = "release view"
echo "\${RELEASE_JSON}"`);
  command("npm", `test "$1" = "view"
if [ "$2" = "@rudderhq/package-14" ] && [ "$3" = "dist-tags.canary" ]; then
  echo "\${LAST_CANARY_VERSION:-$RELEASE_VERSION}"
else
  echo "$RELEASE_VERSION"
fi`);
  const result = runScript("Verify manual canary public surfaces", {
    PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: join(dir, "commands.log"),
    GITHUB_REPOSITORY: "owner/rudder", RELEASE_TAG: "canary/v0.7.24-canary.21",
    RELEASE_VERSION: "0.7.24-canary.21", SOURCE_SHA: sourceSha,
    RELEASE_JSON: JSON.stringify({ isPrerelease: true, isDraft: false, tagName: "canary/v0.7.24-canary.21" }),
    ...env,
  }, dir);
  return { ...result, commands: readFileSync(join(dir, "commands.log"), "utf8") };
}

describe("manual canary terminal completeness", () => {
  it.each(["false", "true"])("accepts only complete matching stages for dry_run=%s", (dryRun) => {
    const env = terminalEnv(dryRun);
    expect(runScript("Require every manual canary stage", env).status).toBe(0);
    for (const [key, value] of Object.entries(env)) {
      if (!key.endsWith("_RESULT")) continue;
      for (const bad of ["failure", "cancelled", value === "success" ? "skipped" : "success", ""]) {
        expect(runScript("Require every manual canary stage", { ...env, [key]: bad }).status, `${key}=${bad}`).not.toBe(0);
      }
    }
  });

  it("runs even after a blocked preflight instead of falsely reporting completion", () => {
    const needs = candidateNeeds();
    needs.preflight = { result: "failure", outputs: {} };
    expect(condition("canary-release-result", dispatch(), needs)).toBe(true);
    expect(runScript("Require every manual canary stage", { ...terminalEnv(), PREFLIGHT_RESULT: "failure" }).status).not.toBe(0);
  });

  it("executes the final public readback across all 14 packages without a mutation", () => {
    const result = publicSurfaceFixture();
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands.match(/^npm view @rudderhq\/package-\d+@0\.7\.24-canary\.21 version$/gm)).toHaveLength(14);
    expect(result.commands.match(/^npm view @rudderhq\/package-\d+ dist-tags\.canary$/gm)).toHaveLength(14);
    expect(result.commands).not.toMatch(/npm (publish|dist-tag)|git (tag|push)|gh release (create|edit|upload)/);
  });

  it.each([
    { ASSET_STATUS: "1" }, { TAG_SHA: "b".repeat(40) }, { PACKAGE_COUNT: "13" }, { PACKAGE_COUNT: "15" },
    { LAST_CANARY_VERSION: "0.7.24-canary.20" },
    { RELEASE_JSON: JSON.stringify({ isPrerelease: false, isDraft: false, tagName: "canary/v0.7.24-canary.21" }) },
    { RELEASE_JSON: JSON.stringify({ isPrerelease: true, isDraft: true, tagName: "canary/v0.7.24-canary.21" }) },
    { RELEASE_JSON: JSON.stringify({ isPrerelease: true, isDraft: false, tagName: "canary/v0.7.24-canary.20" }) },
  ])("fails closed on an incomplete or mismatched public surface: %j", (env) => {
    expect(publicSurfaceFixture(env).status).not.toBe(0);
  });

  it("verifies public canary identity and every package only after production stage success", () => {
    const verify = step("Verify manual canary public surfaces");
    expect(verify).toContain("if: inputs.dry_run == false");
    expect(verify).toContain("wait-for-desktop-release-assets.mjs");
    expect(verify).toContain('git ls-remote --tags origin "refs/tags/$RELEASE_TAG"');
    expect(verify).toContain(".isPrerelease == true and .isDraft == false and .tagName == $tag");
    expect(verify).toContain("release-package-map.mjs list");
    expect(verify).toContain("dist-tags.canary");
    expect(verify).not.toContain("dist-tags.latest");
    expect(job("canary-release-result")).not.toContain("contents: write");
    expect(job("canary-release-result")).not.toContain("id-token: write");
    expect(job("canary-release-result")).not.toContain("npm publish");
  });
});
