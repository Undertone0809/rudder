import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function verifyDispatchSource({ sourceSha, dispatchRef, dispatchSha, cwd = process.cwd() }) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? "")) throw new Error("source_sha must be an immutable commit SHA");
  if (git("rev-parse", "HEAD") !== sourceSha) throw new Error("checkout does not match source_sha");
  if (dispatchRef === "refs/heads/main") return;

  if (!/^refs\/heads\/codex\/release-v\d+\.\d+\.\d+$/.test(dispatchRef ?? "")) {
    throw new Error("Test dispatch requires main or a release-maintenance branch");
  }
  if (dispatchSha !== sourceSha) throw new Error("release-maintenance dispatch must match its branch HEAD");
  git("fetch", "origin", "+refs/heads/main:refs/remotes/origin/main");
  const parents = git("rev-list", "--parents", "-n", "1", sourceSha).split(" ").slice(1);
  if (parents.length !== 1) throw new Error("release-maintenance source must have one parent");
  git("merge-base", "--is-ancestor", parents[0], "refs/remotes/origin/main");
  git("diff", "--exit-code", "refs/remotes/origin/main", sourceSha, "--",
    ".github/workflows/ci.yml", "scripts/ci-dispatch-source.mjs");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyDispatchSource({
      sourceSha: process.env.SOURCE_SHA,
      dispatchRef: process.env.GITHUB_REF,
      dispatchSha: process.env.GITHUB_SHA,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
