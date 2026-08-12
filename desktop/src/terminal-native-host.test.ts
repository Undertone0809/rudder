import { once } from "node:events";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { spawnNativeProcessHost } from "./local-app-native-host.js";

const binaryName = process.platform === "win32" ? "rudder-process-host.exe" : "rudder-process-host";
const nativeHostPath = fileURLToPath(new URL(`../../native/target/debug/${binaryName}`, import.meta.url));
const nativeHostAvailable = await access(nativeHostPath).then(() => true).catch(() => false);

describe("Terminal native process host", () => {
  it.skipIf(!nativeHostAvailable || process.platform === "win32")(
    "kills the full PTY tree when setup fails after spawning the shell",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "rudder-terminal-native-setup-failure-"));
      const shellPidPath = path.join(root, "shell.pid");
      const descendantPath = path.join(root, "descendant.pid");
      const host = spawnNativeProcessHost(nativeHostPath, {
        cwd: root,
        env: {
          ...process.env,
          RUDDER_PROCESS_HOST_TEST_PTY_SETUP_FAILURE: "reader",
          RUDDER_PROCESS_HOST_TEST_PTY_SETUP_DELAY_MS: "500",
        },
      });
      const messages: Array<{ type?: unknown; status?: unknown; cleanupProven?: unknown }> = [];
      host.on("message", (message: unknown) => {
        if (message && typeof message === "object") messages.push(message as typeof messages[number]);
      });
      const exited = once(host, "exit");
      host.send({
        type: "startTerminal",
        protocolVersion: { major: 1, minor: 0 },
        requestId: "terminal-post-spawn-failure",
        executable: "/bin/sh",
        argv: ["-c", `echo $$ > ${JSON.stringify(shellPidPath)}; sleep 30 & echo $! > ${JSON.stringify(descendantPath)}; wait`],
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color" },
        ownerToken: "terminal-post-spawn-failure",
        cols: 80,
        rows: 24,
      });
      await vi.waitFor(async () => {
        expect((await readFile(shellPidPath, "utf8")).trim()).toMatch(/^\d+$/u);
        expect((await readFile(descendantPath, "utf8")).trim()).toMatch(/^\d+$/u);
      }, { timeout: 3_000 });
      const shellPid = Number.parseInt((await readFile(shellPidPath, "utf8")).trim(), 10);
      const descendantPid = Number.parseInt((await readFile(descendantPath, "utf8")).trim(), 10);

      const [exitCode, signal] = await exited as [number | null, NodeJS.Signals | null];
      expect(exitCode).toBe(1);
      expect(signal).toBeNull();
      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "terminal", status: "failed", cleanupProven: true }),
      ]));
      expect(messages).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "spawned" })]));
      await vi.waitFor(() => {
        expect(() => process.kill(shellPid, 0)).toThrow();
        expect(() => process.kill(descendantPid, 0)).toThrow();
      }, { timeout: 3_000 });
    },
    15_000,
  );

  it.skipIf(!nativeHostAvailable || process.platform === "win32")(
    "kills the shell by handle without claiming tree cleanup when its PID is unavailable",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "rudder-terminal-native-missing-pid-"));
      const shellPidPath = path.join(root, "shell.pid");
      const host = spawnNativeProcessHost(nativeHostPath, {
        cwd: root,
        env: {
          ...process.env,
          RUDDER_PROCESS_HOST_TEST_PTY_SETUP_FAILURE: "missing_pid",
          RUDDER_PROCESS_HOST_TEST_PTY_SETUP_DELAY_MS: "500",
        },
      });
      const messages: Array<{ type?: unknown; status?: unknown; cleanupProven?: unknown; errorCode?: unknown }> = [];
      host.on("message", (message: unknown) => {
        if (message && typeof message === "object") messages.push(message as typeof messages[number]);
      });
      const exited = once(host, "exit");
      host.send({
        type: "startTerminal",
        protocolVersion: { major: 1, minor: 0 },
        requestId: "terminal-missing-pid",
        executable: "/bin/sh",
        argv: ["-c", `echo $$ > ${JSON.stringify(shellPidPath)}; sleep 30`],
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color" },
        ownerToken: "terminal-missing-pid",
        cols: 80,
        rows: 24,
      });
      await vi.waitFor(async () => {
        expect((await readFile(shellPidPath, "utf8")).trim()).toMatch(/^\d+$/u);
      }, { timeout: 3_000 });
      const shellPid = Number.parseInt((await readFile(shellPidPath, "utf8")).trim(), 10);

      const [exitCode, signal] = await exited as [number | null, NodeJS.Signals | null];
      expect(exitCode).toBe(1);
      expect(signal).toBeNull();
      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "terminal",
          status: "failed",
          errorCode: "process_identity_unavailable",
          cleanupProven: false,
        }),
      ]));
      expect(messages).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "spawned" })]));
      await vi.waitFor(() => {
        expect(() => process.kill(shellPid, 0)).toThrow();
      }, { timeout: 3_000 });
    },
    15_000,
  );

  it.skipIf(!nativeHostAvailable || process.platform === "win32")(
    "proves cleanup when PTY startup fails before spawning a shell",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "rudder-terminal-native-failure-"));
      const host = spawnNativeProcessHost(nativeHostPath, { cwd: root });
      const messages: Array<{ type?: unknown; status?: unknown; cleanupProven?: unknown }> = [];
      host.on("message", (message: unknown) => {
        if (message && typeof message === "object") messages.push(message as typeof messages[number]);
      });
      const exited = once(host, "exit");
      host.send({
        type: "startTerminal",
        protocolVersion: { major: 1, minor: 0 },
        requestId: "terminal-pre-spawn-failure",
        executable: path.join(root, "missing-shell"),
        argv: [],
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color" },
        ownerToken: "terminal-pre-spawn-failure",
        cols: 80,
        rows: 24,
      });

      const [exitCode, signal] = await exited as [number | null, NodeJS.Signals | null];
      expect(exitCode).toBe(1);
      expect(signal).toBeNull();
      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "terminal", status: "failed", cleanupProven: true }),
      ]));
      expect(messages).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "spawned" })]));
    },
    10_000,
  );

  it.skipIf(!nativeHostAvailable || process.platform === "win32")(
    "relays interactive PTY input and kills a surviving shell descendant on stop",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "rudder-terminal-native-"));
      const descendantPath = path.join(root, "descendant.pid");
      const host = spawnNativeProcessHost(nativeHostPath, { cwd: root });
      const output: string[] = [];
      const messages: Array<{ type?: unknown; status?: unknown; cleanupProven?: unknown }> = [];
      host.stdout.on("data", (chunk) => output.push(chunk.toString()));
      host.on("message", (message: unknown) => {
        if (message && typeof message === "object") messages.push(message as typeof messages[number]);
      });
      const exited = once(host, "exit");
      host.send({
        type: "startTerminal",
        protocolVersion: { major: 1, minor: 0 },
        requestId: "terminal-descendant-stop",
        executable: "/bin/sh",
        argv: ["-l"],
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color" },
        ownerToken: "terminal-descendant-stop",
        cols: 80,
        rows: 24,
      });
      await vi.waitFor(() => {
        expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: "spawned" })]));
      }, { timeout: 3_000 });
      host.send({
        type: "input",
        protocolVersion: { major: 1, minor: 0 },
        requestId: "terminal-descendant-stop",
        data: `sleep 30 & echo $! > ${JSON.stringify(descendantPath)}; printf 'terminal-ready\\n'\n`,
      });
      await vi.waitFor(async () => {
        expect((await readFile(descendantPath, "utf8")).trim()).toMatch(/^\d+$/u);
        expect(output.join("")).toContain("terminal-ready");
      }, { timeout: 3_000 });
      const descendantPid = Number.parseInt((await readFile(descendantPath, "utf8")).trim(), 10);

      host.send({
        type: "stop",
        protocolVersion: { major: 1, minor: 0 },
        requestId: "terminal-descendant-stop",
      });
      const [exitCode, signal] = await exited as [number | null, NodeJS.Signals | null];
      expect(exitCode).toBe(0);
      expect(signal).toBeNull();
      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "stopped" }),
        expect.objectContaining({ type: "terminal", status: "succeeded", cleanupProven: true }),
      ]));
      await vi.waitFor(() => {
        expect(() => process.kill(descendantPid, 0)).toThrow();
      }, { timeout: 3_000 });
    },
    15_000,
  );
});
