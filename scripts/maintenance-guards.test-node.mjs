import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runForbiddenTokenCheck } from "./check-forbidden-tokens.mjs";
import { listTestFiles, runProject, runProjects } from "./run-vitest-projects.mjs";

function fixture(t, content = "ordinary tracked content\n") {
  const root = mkdtempSync(join(tmpdir(), "rudder-maintenance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root], { stdio: "pipe" });
  writeFileSync(join(root, "sample.txt"), content);
  execFileSync("git", ["add", "--", "sample.txt"], { cwd: root, stdio: "pipe" });
  return root;
}

function check(repoRoot, tokens, exec) {
  const logs = [];
  const errors = [];
  const code = runForbiddenTokenCheck({
    repoRoot,
    tokens,
    ...(exec ? { exec } : {}),
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
  });
  return { code, logs, errors };
}

for (const token of ["$(echo injected > shell-marker)", "`echo injected > shell-marker`", "[", ".*", "--help", "a b", 'a"b', "a'b"]) {
  test(`forbidden-token input stays literal: ${JSON.stringify(token)}`, (t) => {
    const root = fixture(t, `${token}\n`);
    const result = check(root, [token]);
    assert.equal(existsSync(join(root, "shell-marker")), false);
    assert.equal(result.code, 1);
    assert.ok(result.errors.includes('  "sample.txt"'));
    assert.ok(!result.errors.join("\n").includes(token));
  });
}

test("regex metacharacters cannot create false matches", (t) => {
  const result = check(fixture(t), [".*"]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.errors, []);
});

test("no match remains successful and matching content is never logged", (t) => {
  const root = fixture(t, "private-synthetic-token\n");
  assert.equal(check(root, ["absent-literal"]).code, 0);
  const result = check(root, ["PRIVATE-SYNTHETIC-TOKEN"]);
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.errors.join("\n"), /private-synthetic-token/i);
});

test("Git operational failures fail closed in a real non-repository directory", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rudder-non-repo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = check(root, ["synthetic-token"]);
  assert.equal(result.code, 1);
  assert.equal(result.logs.length, 0);
  assert.doesNotMatch(result.errors.join("\n"), /synthetic-token/);
});

for (const properties of [{ status: 2 }, { code: "ENOENT" }, { code: "ENOBUFS" }, { status: null, signal: "SIGTERM" }, { status: 1, signal: "SIGTERM" }]) {
  test(`scanner does not hide execution failure ${JSON.stringify(properties)}`, () => {
    const result = check("/unused", ["synthetic-token"], () => {
      throw Object.assign(new Error("stderr contains synthetic-token"), properties);
    });
    assert.equal(result.code, 1);
    assert.equal(result.logs.length, 0);
    assert.doesNotMatch(result.errors.join("\n"), /synthetic-token/);
  });
}

test("only exit status 1 without a signal is a no-match result", () => {
  const result = check("/unused", ["absent"], () => {
    throw Object.assign(new Error("no match"), { status: 1 });
  });
  assert.equal(result.code, 0);
});

test("Git receives an argument array, fixed-string pattern and filename-only output", () => {
  const token = "$(not-a-command)";
  let invocation;
  check("/unused", [token], (...args) => {
    invocation = args;
    return "sample.txt\0";
  });
  const [command, args, options] = invocation;
  assert.equal(command, "git");
  assert.ok(args.includes("--fixed-strings"));
  assert.ok(args.includes("--files-with-matches"));
  assert.ok(args.includes("-z"));
  assert.equal(args[args.indexOf("-e") + 1], token);
  assert.equal(options.shell, false);
});

test("empty server discovery is a failure rather than a zero-command pass", async () => {
  let launches = 0;
  const result = await runProjects(["server", "cli"], {
    listFiles: async () => [],
    run: async () => { launches += 1; return { code: 0 }; },
    write: () => {},
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.failures[0].project, "server");
  assert.equal(launches, 1);
});

test("an empty project selection cannot count as verification", async () => {
  await assert.rejects(runProjects([], { write: () => {} }), /No test projects/);
});

test("the runner does not add the no-tests success escape hatch", async () => {
  let argv;
  const result = await runProject("server", ["example.test.ts"], {
    spawnChild: (_command, args) => {
      argv = args;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });
  assert.equal(result.code, 0);
  assert.ok(!argv.includes("--passWithNoTests"));
  assert.ok(argv.includes("--passWithNoTests=false"));
});

test("migration test writes use isolated profiles and failed evidence is retained", async (t) => {
  const originalProfile = mkdtempSync(join(tmpdir(), "rudder-original-profile-"));
  t.after(() => rmSync(originalProfile, { recursive: true, force: true }));
  const originalBackup = join(originalProfile, "existing-backup.sql");
  writeFileSync(originalBackup, "existing recovery data");
  const profiles = [];

  for (const code of [0, 7]) {
    let profile;
    const result = await runProject("server", ["migration.test.ts"], {
      env: {
        HOME: "canonical-home-sentinel",
        RUDDER_HOME: originalProfile,
        RUDDER_CONFIG: join(originalProfile, "config.json"),
        RUDDER_DB_BACKUP_DIR: originalProfile,
        DATABASE_URL: "postgresql://non-test.invalid/production",
        RUDDER_NATIVE_DATABASE_URL: "postgresql://non-test.invalid/native-production",
        RUDDER_MIGRATION_APPLY_DATABASE_URL: "postgresql://non-test.invalid/migration-production",
        RUDDER_MIGRATION_PREFLIGHT_DATABASE_URL: "postgresql://non-test.invalid/preflight-production",
        RUDDER_ORGANIZATION_WORKSPACE_HOME: originalProfile,
        RUDDER_NATIVE_MIGRATION_APPLY_PATH: "frozen-native-sentinel",
      },
      spawnChild: (_command, _args, { env }) => {
        profile = env.HOME;
        assert.equal(profile, realpathSync(profile));
        profiles.push(profile);
        t.after(() => rmSync(profile, { recursive: true, force: true }));
        assert.notEqual(profile, originalProfile);
        assert.equal(env.RUDDER_CONFIG, join(profile, "config.json"));
        assert.equal(env.DATABASE_URL, undefined);
        assert.equal(env.RUDDER_NATIVE_DATABASE_URL, undefined);
        assert.equal(env.RUDDER_MIGRATION_APPLY_DATABASE_URL, undefined);
        assert.equal(env.RUDDER_MIGRATION_PREFLIGHT_DATABASE_URL, undefined);
        assert.equal(env.RUDDER_DB_BACKUP_DIR, undefined);
        assert.equal(env.RUDDER_ORGANIZATION_WORKSPACE_HOME, undefined);
        assert.equal(env.RUDDER_HOME, undefined);
        assert.equal(env.USERPROFILE, profile);
        assert.equal(env.RUSTUP_HOME, join("canonical-home-sentinel", ".rustup"));
        assert.equal(env.CARGO_HOME, join("canonical-home-sentinel", ".cargo"));
        assert.equal(env.COREPACK_HOME, join("canonical-home-sentinel", process.platform === "win32" ? "AppData/Local" : ".cache", "node/corepack"));
        assert.equal(env.RUDDER_NATIVE_MIGRATION_APPLY_PATH, "frozen-native-sentinel");
        writeFileSync(join(profile, "simulated-backup.sql.partial"), "test evidence");
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("exit", code, null));
        return child;
      },
    });
    assert.equal(result.code, code);
    assert.equal(existsSync(profile), code !== 0);
    if (code !== 0) {
      assert.equal(readFileSync(join(profile, "simulated-backup.sql.partial"), "utf8"), "test evidence");
    }
  }

  assert.notEqual(profiles[0], profiles[1]);
  assert.equal(readFileSync(originalBackup, "utf8"), "existing recovery data");
  assert.equal(existsSync(join(originalProfile, "simulated-backup.sql.partial")), false);
});

test("Node-native suites are explicitly dispatched outside Vitest", async () => {
  const serverRoot = new URL("../server/", import.meta.url);
  const serverFiles = await listTestFiles(fileURLToPath(serverRoot));
  assert.ok(!serverFiles.includes("scripts/stage-native.test.mjs"));

  const packageManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    packageManifest.scripts["test:node-suites"],
    "node --test scripts/release-candidate-manifest.test.mjs server/scripts/stage-native.test.mjs",
  );
  assert.ok(packageManifest.scripts["test:run"].includes("pnpm test:node-suites"));

  const scriptsVitestConfig = readFileSync(new URL("./vitest.config.ts", import.meta.url), "utf8");
  assert.match(
    scriptsVitestConfig,
    /exclude:\s*\[\.\.\.configDefaults\.exclude,\s*"release-candidate-manifest\.test\.mjs"\]/u,
  );
});

test("ordinary failure aggregation and later projects are preserved", async () => {
  const launches = [];
  const result = await runProjects(["server", "cli"], {
    listFiles: async () => ["first.test.ts", "second.test.ts"],
    run: async (project, files = []) => {
      launches.push([project, files]);
      return { code: files[0] === "first.test.ts" ? 2 : 0 };
    },
    write: () => {},
  });
  assert.equal(launches.length, 3);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.failures, [{ project: "server", testFile: "first.test.ts", code: 2 }]);
});
