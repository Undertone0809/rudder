import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyDispatchSource } from "./ci-dispatch-source.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rudder-ci-dispatch-"));
  roots.push(root);
  const cwd = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(join(cwd, ".github", "workflows"), { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--bare", remote);
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(cwd, ".github", "workflows", "ci.yml"), "name: Test\n");
  git("add", ".");
  git("commit", "-m", "base");
  git("remote", "add", "origin", remote);
  git("push", "origin", "main");
  const mainSha = git("rev-parse", "HEAD");
  git("checkout", "-b", "codex/release-v0.5.2");
  writeFileSync(join(cwd, "package.json"), '{"version":"0.5.2"}\n');
  git("add", ".");
  git("commit", "-m", "bump");
  const sourceSha = git("rev-parse", "HEAD");
  return { cwd, git, mainSha, sourceSha, dispatchSha: sourceSha, dispatchRef: "refs/heads/codex/release-v0.5.2" };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("controlled release-maintenance CI dispatch", () => {
  it("accepts maintenance branch HEAD and preserves trusted-main exact-source checks", () => {
    const options = fixture();
    expect(() => verifyDispatchSource(options)).not.toThrow();
    expect(() => verifyDispatchSource({ ...options, dispatchRef: "refs/heads/main", dispatchSha: options.mainSha })).not.toThrow();
  });

  it("rejects arbitrary feature branches and mismatched maintenance SHA", () => {
    const options = fixture();
    expect(() => verifyDispatchSource({ ...options, dispatchRef: "refs/heads/codex/feature" })).toThrow("requires main or a release-maintenance branch");
    expect(() => verifyDispatchSource({ ...options, dispatchSha: options.mainSha })).toThrow("must match its branch HEAD");
    expect(() => verifyDispatchSource({ ...options, sourceSha: options.mainSha })).toThrow("checkout does not match");
  });

  it("rejects changed workflow code and a parent outside main", () => {
    const options = fixture();
    writeFileSync(join(options.cwd, ".github", "workflows", "ci.yml"), "name: Changed\n");
    options.git("add", ".");
    options.git("commit", "--amend", "--no-edit");
    let sourceSha = options.git("rev-parse", "HEAD");
    expect(() => verifyDispatchSource({ ...options, sourceSha, dispatchSha: sourceSha })).toThrow();
    writeFileSync(join(options.cwd, "extra.txt"), "another commit\n");
    options.git("add", ".");
    options.git("commit", "-m", "extra");
    sourceSha = options.git("rev-parse", "HEAD");
    expect(() => verifyDispatchSource({ ...options, sourceSha, dispatchSha: sourceSha })).toThrow();
  });

  it("rejects a no-op candidate guard before executing it from every workflow bootstrap", () => {
    const options = fixture();
    mkdirSync(join(options.cwd, "scripts"));
    writeFileSync(join(options.cwd, "scripts", "ci-dispatch-source.mjs"), "process.exit(0);\n");
    options.git("add", ".");
    options.git("commit", "--amend", "--no-edit");
    const sourceSha = options.git("rev-parse", "HEAD");
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const blocks = [...workflow.matchAll(/        run: \|\n((?:          .*\n)+)/g)]
      .map((match) => match[1].replace(/^          /gm, ""))
      .filter((block) => block.includes("node scripts/ci-dispatch-source.mjs"));
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(() => execFileSync("bash", ["-c", block], {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SOURCE_SHA: sourceSha, GITHUB_SHA: sourceSha, GITHUB_REF: options.dispatchRef },
      })).toThrow();
      expect(() => execFileSync("bash", ["-c", block], {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SOURCE_SHA: sourceSha, GITHUB_SHA: options.mainSha, GITHUB_REF: "refs/heads/main" },
      })).not.toThrow();
      expect(() => execFileSync("bash", ["-c", block], {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SOURCE_SHA: options.mainSha, GITHUB_SHA: options.mainSha, GITHUB_REF: "refs/heads/main" },
      })).toThrow();
    }
  });
});
