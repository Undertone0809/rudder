import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const tempRoots = [];

function exec(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createReleaseRepo() {
  const root = mkdtempSync(join(tmpdir(), "rudder-release-test-"));
  tempRoots.push(root);

  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "cli"), { recursive: true });

  for (const fileName of ["release.sh", "release-lib.sh", "release-package-map.mjs"]) {
    cpSync(join(scriptsDir, fileName), join(repo, "scripts", fileName));
  }
  chmodSync(join(repo, "scripts", "release.sh"), 0o755);
  chmodSync(join(repo, "scripts", "release-lib.sh"), 0o755);
  chmodSync(join(repo, "scripts", "release-package-map.mjs"), 0o755);

  writeJson(join(repo, "cli", "package.json"), {
    name: "@rudderhq/cli",
    version: "0.2.2",
  });

  exec("git", ["init", "--bare", remote], { cwd: root });
  exec("git", ["init"], { cwd: repo });
  exec("git", ["checkout", "-b", "main"], { cwd: repo });
  exec("git", ["config", "user.name", "Release Test"], { cwd: repo });
  exec("git", ["config", "user.email", "release-test@example.com"], { cwd: repo });
  exec("git", ["add", "."], { cwd: repo });
  exec("git", ["commit", "-m", "fixture"], { cwd: repo });
  exec("git", ["remote", "add", "origin", remote], { cwd: repo });
  exec("git", ["push", "-u", "origin", "main"], { cwd: repo });

  return { repo };
}

function runPrintVersion(repo, env = {}) {
  return spawnSync("./scripts/release.sh", ["canary", "--print-version"], {
    cwd: repo,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
  });
}

function runWaitForNpmPackageVersions(repo, packageInfo, env = {}) {
  return spawnSync("bash", [
    "-c",
    [
      ". ./scripts/release-lib.sh",
      'wait_for_npm_package_versions "$PACKAGE_INFO" 4 0',
      "status=$?",
      'printf "missing=%s\\n" "$WAIT_FOR_NPM_PACKAGE_VERSIONS_MISSING"',
      'exit "$status"',
    ].join("\n"),
  ], {
    cwd: repo,
    env: {
      ...process.env,
      PACKAGE_INFO: packageInfo,
      ...env,
    },
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("release canary base guard", () => {
  it("fails before deriving a canary when the committed base has a stable remote tag", () => {
    const { repo } = createReleaseRepo();

    exec("git", ["tag", "v0.2.2"], { cwd: repo });
    exec("git", ["push", "origin", "v0.2.2"], { cwd: repo });
    exec("git", ["tag", "-d", "v0.2.2"], { cwd: repo });

    const result = runPrintVersion(repo);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("canary base version 0.2.2 has already been released as stable");
    expect(result.stderr).toContain("git tag v0.2.2 exists on origin");
    expect(result.stderr).toContain("0.2.2 -> 0.2.3");
  });

  it("fails before deriving a canary when the committed base exists as a stable npm package", () => {
    const { repo } = createReleaseRepo();
    const mockBin = resolve(repo, "..", "bin");
    mkdirSync(mockBin, { recursive: true });
    const npmPath = join(mockBin, "npm");
    writeFileSync(npmPath, [
      "#!/usr/bin/env bash",
      "if [ \"$1\" = \"view\" ] && [ \"$2\" = \"@rudderhq/cli@0.2.2\" ] && [ \"$3\" = \"version\" ]; then",
      "  echo \"0.2.2\"",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"));
    chmodSync(npmPath, 0o755);

    const result = runPrintVersion(repo, {
      PATH: `${mockBin}:${process.env.PATH}`,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("canary base version 0.2.2 has already been released as stable");
    expect(result.stderr).toContain("npm package @rudderhq/cli@0.2.2 exists");
    expect(result.stderr).toContain("0.2.2 -> 0.2.3");
  }, 15000);
});

describe("npm publish verification", () => {
  it("keeps polling all packages until npm exposes delayed versions", () => {
    const { repo } = createReleaseRepo();
    const mockBin = resolve(repo, "..", "bin");
    const stateDir = resolve(repo, "..", "npm-state");
    mkdirSync(mockBin, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const npmPath = join(mockBin, "npm");
    writeFileSync(npmPath, [
      "#!/usr/bin/env bash",
      "if [ \"$1\" != \"view\" ]; then exit 1; fi",
      "spec=\"$2\"",
      "version_arg=\"$3\"",
      "safe_spec=\"$(printf '%s' \"$spec\" | tr -c 'A-Za-z0-9_.-' '_')\"",
      "count_file=\"$NPM_MOCK_STATE_DIR/$safe_spec\"",
      "count=0",
      "if [ -f \"$count_file\" ]; then count=\"$(cat \"$count_file\")\"; fi",
      "count=$((count + 1))",
      "printf '%s' \"$count\" > \"$count_file\"",
      "case \"$spec:$version_arg\" in",
      "  '@rudderhq/cli@0.2.2:version')",
      "    echo '0.2.2'",
      "    exit 0",
      "    ;;",
      "  '@rudderhq/server@0.2.2:version')",
      "    if [ \"$count\" -ge 3 ]; then",
      "      echo '0.2.2'",
      "      exit 0",
      "    fi",
      "    exit 1",
      "    ;;",
      "esac",
      "exit 1",
      "",
    ].join("\n"));
    chmodSync(npmPath, 0o755);

    const packageInfo = [
      "cli\t@rudderhq/cli\t0.2.2",
      "server\t@rudderhq/server\t0.2.2",
    ].join("\n");
    const result = runWaitForNpmPackageVersions(repo, packageInfo, {
      NPM_MOCK_STATE_DIR: stateDir,
      PATH: `${mockBin}:${process.env.PATH}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Waiting for npm to expose: @rudderhq/server@0.2.2");
    expect(result.stdout).toContain("missing=");
    expect(result.stderr).toBe("");
  });
});
