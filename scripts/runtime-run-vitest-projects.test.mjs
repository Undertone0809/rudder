import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { runProject, runProjects } from "./run-vitest-projects.mjs";

function fakeChild(exit) {
  const child = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => exit(child));
  return child;
}

test("collects ordinary failures and runs later server files and projects", async () => {
  const exitCodes = [1, 0, 2];
  const commands = [];
  const output = [];
  const spawnChild = (_command, args) => {
    const rootIndex = args.indexOf("--root");
    commands.push({
      project: args[rootIndex + 1],
      testFile: args.find((arg) => arg.endsWith(".test.ts")),
    });
    const code = exitCodes[commands.length - 1];
    return fakeChild((child) => child.emit("exit", code, null));
  };

  const result = await runProjects(["server", "packages/shared"], {
    listFiles: async () => ["first.test.ts", "later.test.ts"],
    run: (project, files) => runProject(project, files, { spawnChild }),
    write: (text) => output.push(text),
  });

  assert.deepEqual(commands, [
    { project: "server", testFile: "first.test.ts" },
    { project: "server", testFile: "later.test.ts" },
    { project: "packages/shared", testFile: undefined },
  ]);
  assert.deepEqual(result.failures, [
    { project: "server", testFile: "first.test.ts", code: 1 },
    { project: "packages/shared", code: 2 },
  ]);
  assert.equal(result.exitCode, 1);
  assert.match(output.join(""), /2 Vitest command\(s\) failed/);
});

test("stops scheduling after a fatal child launch error", async () => {
  let launches = 0;
  const spawnChild = () => {
    launches += 1;
    return fakeChild((child) => child.emit("error", new Error("spawn failed")));
  };

  await assert.rejects(
    runProjects(["server", "packages/shared"], {
      listFiles: async () => ["first.test.ts", "later.test.ts"],
      run: (project, files) => runProject(project, files, { spawnChild }),
      write: () => {},
    }),
    /spawn failed/,
  );
  assert.equal(launches, 1);
});

test("stops scheduling when a child terminates by signal", async () => {
  let launches = 0;
  const spawnChild = () => {
    launches += 1;
    return fakeChild((child) => child.emit("exit", null, "SIGTERM"));
  };

  await assert.rejects(
    runProjects(["server", "packages/shared"], {
      listFiles: async () => ["first.test.ts", "later.test.ts"],
      run: (project, files) => runProject(project, files, { spawnChild }),
      write: () => {},
    }),
    /terminated by SIGTERM/,
  );
  assert.equal(launches, 1);
});

test("parent signals remain fatal when a child exits successfully", () => {
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const runnerPath = fileURLToPath(new URL("./run-vitest-projects.mjs", import.meta.url));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    for (const projects of [["packages/shared"], ["packages/shared", "cli"]]) {
      const preloader = `
        import { EventEmitter } from "node:events";
        import childProcess from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        let launches = 0;
        let kills = 0;
        childProcess.spawn = () => {
          launches += 1;
          const child = new EventEmitter();
          child.kill = () => {
            kills += 1;
            queueMicrotask(() => child.emit("exit", 0, null));
          };
          queueMicrotask(() => process.emit(process.env.RUNNER_TEST_SIGNAL));
          return child;
        };
        syncBuiltinESMExports();
        process.on("exit", () => {
          process.stdout.write("RUNNER_FIXTURE=" + JSON.stringify({ launches, kills }) + "\\n");
        });
      `;
      const expectedExitCode = signal === "SIGINT" ? 130 : 143;
      const child = spawnSync(process.execPath, [
        "--import",
        `data:text/javascript,${encodeURIComponent(preloader)}`,
        runnerPath,
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          RUDDER_TEST_PROJECTS: projects.join(","),
          RUNNER_TEST_SIGNAL: signal,
        },
        encoding: "utf8",
        timeout: 5000,
      });

      assert.equal(child.status, expectedExitCode, `${signal} should keep the parent run failing`);
      const fixtureLine = child.stdout.split("\n").find((line) => line.startsWith("RUNNER_FIXTURE="));
      assert.deepEqual(JSON.parse(fixtureLine.slice("RUNNER_FIXTURE=".length)), { launches: 1, kills: 1 });
      if (projects.length > 1) assert.doesNotMatch(child.stdout, /\[test:run\] cli/);
    }
  }
});
