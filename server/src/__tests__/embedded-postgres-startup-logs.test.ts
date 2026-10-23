import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createEmbeddedPostgresStartupLogBuffer } from "../embedded-postgres-startup-logs.js";

// Execute ONLY the installed package's initdb spawn/promise block with a fake
// child. No binary resolution, password-file writes, initdb or PG is executed.
const dependencySource = readFileSync(process.env.RUDDER_EMBEDDED_POSTGRES_TEST_SOURCE
  ?? createRequire(new URL("../../../packages/db/package.json", import.meta.url)).resolve("embedded-postgres"), "utf8");
const block = dependencySource.slice(dependencySource.indexOf("// Initialize the database"), dependencySource.indexOf("// Clean up the file"));

function mockedInitialise() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  const logs = createEmbeddedPostgresStartupLogBuffer();
  const invoke = new Function("spawn", "initdb", "passwordFile", "permissionIds", "LC_MESSAGES_LOCALE",
    block.replace("yield new Promise", "return new Promise"));
  const promise = invoke.call({ options: { databaseDir: "/disposable", authMethod: "password", user: "rudder",
    initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: logs.append, onError: logs.append } },
  () => child, "/not-executed/initdb", "/not-written/password", {}, "en_US.UTF-8") as Promise<void>;
  return { child, logs, promise };
}

describe("embedded PostgreSQL init diagnostics", () => {
  it("retains initdb stderr arriving after exit until close", async () => {
    const { child, logs, promise } = mockedInitialise();
    let settled = false;
    const observed = promise.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
    child.stdout.emit("data", Buffer.from("running bootstrap script ...\n"));
    child.emit("exit", 1, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stderr.emit("data", Buffer.from("FATAL: bootstrap allocation failed"));
    child.emit("close", 1, null);
    expect(await observed).toBe("Postgres init script exited with code 1. Please check the logs for extra info. The data directory might already exist.");
    logs.flush();
    expect(logs.lines).toEqual(["running bootstrap script ...", "FATAL: bootstrap allocation failed"]);
  });

  it("preserves successful exit zero after stream close", async () => {
    const { child, logs, promise } = mockedInitialise();
    child.emit("exit", 0, null);
    child.stderr.emit("data", Buffer.from("initdb: warning: example warning\n"));
    child.emit("close", 0, null);
    await expect(promise).resolves.toBeUndefined();
    expect(logs.lines).toEqual(["initdb: warning: example warning"]);
  });

  it("retains null exit and signal without implying success", async () => {
    const { child, promise } = mockedInitialise();
    const observed = promise.catch(error => error);
    child.emit("close", null, "SIGTERM");
    expect(await observed).toBe("Postgres init script exited with code null (signal SIGTERM). Please check the logs for extra info. The data directory might already exist.");
  });

  it("preserves spawn errors without waiting for exit or changing the cause", async () => {
    const { child, promise } = mockedInitialise();
    const error = Object.assign(new Error("spawn initdb ENOENT"), { code: "ENOENT" });
    const observed = promise.catch(value => value);
    child.emit("error", error);
    expect(await observed).toBe(error);
    child.emit("close", null, null);
    expect(await observed).toBe(error);
  });

  it("redacts split credentials before buffer or verbose publication", () => {
    const published: string[] = [];
    const logs = createEmbeddedPostgresStartupLogBuffer(line => published.push(line));
    logs.append("FATAL password=split");
    expect(logs.lines).toEqual([]);
    expect(published).toEqual([]);
    logs.append("secret bearer private-token postgres://rudder:db-secret@localhost/db\n");
    logs.append("token=last-secret");
    logs.flush();
    expect(logs.lines.join("\n")).not.toMatch(/splitsecret|private-token|db-secret|last-secret/);
    expect(published).toEqual(logs.lines);
    expect(logs.lines).toEqual(["FATAL password=[REDACTED] bearer [REDACTED] postgres://rudder:[REDACTED]@localhost/db", "token=[REDACTED]"]);
  });

  it("retains a total UTF8 tail below 8 KiB and the existing 120-line cap", () => {
    const logs = createEmbeddedPostgresStartupLogBuffer();
    for (let index = 0; index < 200; index += 1) logs.append(`${index}: ${"诊断🙂".repeat(20)}\n`);
    logs.append("FATAL: last bootstrap reason");
    logs.flush();
    expect(Buffer.byteLength(logs.lines.join("\n"))).toBeLessThanOrEqual(8 * 1024);
    expect(logs.lines.length).toBeLessThanOrEqual(120);
    expect(logs.lines.at(-1)).toBe("FATAL: last bootstrap reason");
    expect(logs.lines.some(line => line.startsWith("0: "))).toBe(false);
  });

  it("does not expose an over-limit split line or expand past the sanitized limit", () => {
    const published: string[] = [];
    const logs = createEmbeddedPostgresStartupLogBuffer(line => published.push(line));
    logs.append(`password=${"a".repeat(9000)}`);
    logs.append("secret-tail\nFATAL: retained next line\n");
    logs.append("123456 ".repeat(1100)); // redaction expands this sub-8KiB raw line
    logs.flush();
    expect(published).toEqual(["[over-limit PostgreSQL startup line omitted]", "FATAL: retained next line",
      "[over-limit PostgreSQL startup line omitted]"]);
    expect(Buffer.byteLength(logs.lines.join("\n"))).toBeLessThanOrEqual(8 * 1024);
    expect(logs.lines.join("\n")).not.toContain("secret-tail");
  });
});
