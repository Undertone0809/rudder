import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runForbiddenTokenCheck } from "./check-forbidden-tokens.mjs";
import { runProject, runProjects } from "./run-vitest-projects.mjs";

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
