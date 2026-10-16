import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createOfficialPostgresInstance, resolveOfficialPostgresLogPath } from "../../packages/db/dist/local-postgres-provider.js";

// Real Windows PostgreSQL regression. All writes and abrupt stops target a new
// disposable cluster. --compare additionally measures the previous log layout.
assert.equal(process.platform, "win32", "This regression needs Windows file sharing semantics");
const binDir = process.env.RUDDER_POSTGRES_BIN_DIR;
assert.ok(binDir, "Set RUDDER_POSTGRES_BIN_DIR to PostgreSQL 18.4 bin");
const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const postgres = require("postgres");
const root = await mkdtemp(path.join(os.tmpdir(), "rudder-windows-pg-recovery-"));
const databaseDir = path.join(root, "db");
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const value = server.address().port;
    server.close(() => resolve(value));
  });
});
const options = { databaseDir, user: "rudder", password: "disposable-recovery-test", port, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"] };
const instance = createOfficialPostgresInstance(binDir, options);
const runControl = (args) => new Promise((resolve, reject) => {
  const child = spawn(path.join(binDir, "pg_ctl.exe"), args, { stdio: "ignore", windowsHide: true });
  child.once("error", reject);
  child.once("exit", code => code === 0 ? resolve() : reject(new Error(`pg_ctl exited ${code}`)));
});
const stop = (mode) => runControl(["-D", databaseDir, "-m", mode, "-w", "stop"]);
const sql = () => postgres({ host: "127.0.0.1", port, database: "postgres", username: options.user, password: options.password, max: 1 });
const durations = {};
const timed = async (name, action) => {
  const start = performance.now();
  await action();
  durations[name] = Math.round(performance.now() - start);
};
let running = false;
console.log(JSON.stringify({ root, port, binDir }));
try {
  await instance.initialise();
  // Start with the legacy log so the historical file is present in PGDATA.
  const legacyStart = () => runControl(["-D", databaseDir, "-l", path.join(databaseDir, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"]);
  await legacyStart();
  running = true;
  const seed = sql();
  try {
    await seed`create table startup_sentinel (value text not null)`;
    await seed`insert into startup_sentinel values ('committed-before-recovery')`;
  } finally { await seed.end(); }
  await stop("immediate");
  running = false;
  if (process.argv.includes("--compare")) {
    await timed("legacyCrashRestartMs", legacyStart);
    running = true;
    await stop("immediate");
    running = false;
  }
  await timed("candidateCrashRestartMs", () => instance.start());
  running = true;
  const verify = sql();
  try {
    const rows = await verify`select value from startup_sentinel`;
    assert.deepEqual(rows.map(row => row.value), ["committed-before-recovery"]);
  } finally { await verify.end(); }
  const logPath = resolveOfficialPostgresLogPath(databaseDir);
  const recoveryLog = await readFile(logPath, "utf8");
  assert.match(recoveryLog, /automatic recovery in progress/);
  assert.doesNotMatch(recoveryLog, /sharing violation|Continuing to retry for 30 seconds/);
  assert.ok(await readFile(path.join(databaseDir, "postgres.log"), "utf8"));
  await stop("fast");
  running = false;
  await timed("candidateCleanRestartMs", () => instance.start());
  running = true;
  console.log(JSON.stringify({ result: "PASS", root, logPath, durations, sentinel: "preserved", legacyLog: "retained" }, null, 2));
} finally {
  if (running) await stop("fast");
}
