import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import globalSetup from "./vitest-postgres-global-setup.ts";

it.skipIf(process.platform === "win32")("cleans only its own project processes while parallel and E2E databases remain alive", async () => {
  const originalTemp = os.tmpdir();
  const first = { config: {} };
  const second = { config: { env: {} } };
  const cleanupFirst = await globalSetup(first);
  const cleanupSecond = await globalSetup(second);
  const children = [];
  async function startPostgresShapedProcess(dataDirectory) {
    const child = spawn(process.execPath, [
      "-e",
      "process.title = 'postgres -D ' + process.argv[1]; process.send('ready'); setInterval(() => {}, 1000);",
      dataDirectory,
    ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const exited = once(child, "exit");
    children.push({ child, exited });
    await once(child, "message");
    return { child, exited };
  }
  try {
    expect(first.config.env.TMPDIR).not.toBe(second.config.env.TMPDIR);
    expect(os.tmpdir()).toBe(originalTemp);
    const owned = await startPostgresShapedProcess(path.join(first.config.env.TMPDIR, "db"));
    const parallel = await startPostgresShapedProcess(path.join(second.config.env.TMPDIR, "db"));
    const similarlyNamed = await startPostgresShapedProcess(`${first.config.env.TMPDIR}-other/db`);
    const e2e = await startPostgresShapedProcess(path.join(originalTemp, "rudder-e2e-independent", "db"));

    await cleanupFirst();
    await owned.exited;
    for (const { child } of [parallel, similarlyNamed, e2e]) {
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(() => process.kill(child.pid, 0)).not.toThrow();
    }
    await cleanupSecond();
    await parallel.exited;
    expect(() => process.kill(e2e.child.pid, 0)).not.toThrow();
  } finally {
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    }
    await cleanupFirst();
    await cleanupSecond();
  }
}, 15_000);
