#!/usr/bin/env node
/**
 * check-forbidden-tokens.mjs
 *
 * Scans the codebase for forbidden tokens before publishing to npm.
 * Mirrors the git pre-commit hook logic, but runs against the full
 * working tree (not just staged changes).
 *
 * Token list: .git/hooks/forbidden-tokens.txt (one per line, # comments ok).
 * If the file is missing, the check still uses the active local username when
 * available. If username detection fails, the check degrades gracefully.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function uniqueNonEmpty(values) {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

export function resolveDynamicForbiddenTokens(env = process.env, osModule = os) {
  const candidates = [env.USER, env.LOGNAME, env.USERNAME];

  try {
    candidates.push(osModule.userInfo().username);
  } catch {
    // Some environments do not expose userInfo; env vars are enough fallback.
  }

  return uniqueNonEmpty(candidates);
}

export function readForbiddenTokensFile(tokensFile) {
  if (!existsSync(tokensFile)) return [];

  return readFileSync(tokensFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function resolveForbiddenTokens(tokensFile, env = process.env, osModule = os) {
  return uniqueNonEmpty([
    ...resolveDynamicForbiddenTokens(env, osModule),
    ...readForbiddenTokensFile(tokensFile),
  ]);
}

export function runForbiddenTokenCheck({
  repoRoot,
  tokens,
  exec = execFileSync,
  log = console.log,
  error = console.error,
}) {
  if (tokens.length === 0) {
    log("  ℹ  Forbidden tokens list is empty — skipping check.");
    return 0;
  }

  let found = false;

  for (const token of tokens) {
    try {
      // Tokens are data, never shell source or regular expressions. Return only
      // filenames so a privacy check cannot leak matching content into CI logs.
      const result = exec(
        "git",
        ["grep", "--fixed-strings", "--ignore-case", "--files-with-matches", "-z", "--no-color", "-e", token, "--", ":!pnpm-lock.yaml", ":!.git"],
        {
          encoding: "utf8",
          cwd: repoRoot,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      if (result.length > 0) {
        if (!found) {
          error("ERROR: Forbidden tokens found in tracked files:\n");
        }
        found = true;
        for (const file of result.split("\0").filter(Boolean)) {
          error(`  ${JSON.stringify(file)}`);
        }
      }
    } catch (failure) {
      // Only Git's ordinary no-match status is safe. Missing Git, invalid
      // repositories, signals, timeouts and truncated output must block release.
      if (failure?.status === 1 && !failure.signal && !failure.code) continue;
      error("ERROR: Forbidden-token scan failed; publishing is blocked. Check Git availability and repository access.");
      return 1;
    }
  }

  if (found) {
    error("\nBuild blocked. Remove the forbidden token(s) before publishing.");
    return 1;
  }

  log("  ✓  No forbidden tokens found.");
  return 0;
}

function resolveRepoPaths(exec = execFileSync) {
  const repoRoot = exec("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", shell: false }).trim();
  const gitDir = exec("git", ["rev-parse", "--git-dir"], { encoding: "utf8", cwd: repoRoot, shell: false }).trim();
  return {
    repoRoot,
    tokensFile: resolve(repoRoot, gitDir, "hooks/forbidden-tokens.txt"),
  };
}

function main() {
  const { repoRoot, tokensFile } = resolveRepoPaths();
  const tokens = resolveForbiddenTokens(tokensFile);
  process.exit(runForbiddenTokenCheck({ repoRoot, tokens }));
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}
