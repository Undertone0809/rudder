import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { spawnNativeProcessHost, type NativeProcessHost } from "./local-app-native-host.js";

const nativeHostPath = process.env.RUDDER_NATIVE_PROCESS_HOST_PATH;
const supportedTarget = (process.platform === "darwin" && ["arm64", "x64"].includes(process.arch))
  || (process.platform === "win32" && process.arch === "x64")
  || (process.platform === "linux" && process.arch === "x64");
const nativeOnly = it.skipIf(!nativeHostPath || !supportedTarget);
const macNativeOnly = it.skipIf(!nativeHostPath || process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch));
const permissionNativeOnly = it.skipIf(!nativeHostPath || !supportedTarget || process.platform === "win32");

async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function fixture(requestId: string) {
  const root = await mkdtemp(path.join(tmpdir(), `rudder-native-host-${requestId}-`));
  const runtimeRoot = path.join(root, "runtime");
  await mkdir(runtimeRoot);
  const helper = spawnNativeProcessHost(nativeHostPath!, { cwd: root });
  const lifecycle: Array<Record<string, unknown>> = [];
  helper.on("message", (message: unknown) => {
    if (message && typeof message === "object") lifecycle.push(message as Record<string, unknown>);
  });
  return { root, runtimeRoot, helper, lifecycle };
}

function sendStart(helper: NativeProcessHost, input: {
  requestId: string;
  root: string;
  runtimeRoot: string;
  port: number;
  script: string;
}) {
  helper.send({
    type: "start",
    protocolVersion: { major: 1, minor: 0 },
    requestId: input.requestId,
    executable: process.execPath,
    argv: ["-e", input.script],
    cwd: input.root,
    env: { PATH: process.env.PATH ?? "" },
    ownerToken: input.requestId,
    port: input.port,
    runtimeRoot: input.runtimeRoot,
  });
}

describe("Rust Local App process host transport", () => {
  nativeOnly("keeps raw stdout and stderr byte-exact and separate from lifecycle JSON", async () => {
    const { root, runtimeRoot, helper, lifecycle } = await fixture("raw-channels");
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    helper.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    helper.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exited = once(helper, "exit");
    sendStart(helper, {
      requestId: "raw-channels",
      root,
      runtimeRoot,
      port: await unusedPort(),
      script: "process.stdout.write(Buffer.from([111,117,116,0,123,34,116,121,112,101,34,58,34,116,101,114,109,105,110,97,108,34,125,255,10]));process.stderr.write(Buffer.from([101,114,114,0,91,49,44,50,93,254,10]));",
    });
    const [code] = await exited as [number | null];
    expect(code).toBe(0);
    expect(Buffer.concat(stdout)).toEqual(Buffer.from([111, 117, 116, 0, 123, 34, 116, 121, 112, 101, 34, 58, 34, 116, 101, 114, 109, 105, 110, 97, 108, 34, 125, 255, 10]));
    expect(Buffer.concat(stderr)).toEqual(Buffer.from([101, 114, 114, 0, 91, 49, 44, 50, 93, 254, 10]));
    expect(lifecycle.filter((frame) => frame.type === "terminal")).toHaveLength(1);
  });

  nativeOnly("admits Stop while output is flooded and proves terminal cleanup", async () => {
    const { root, runtimeRoot, helper, lifecycle } = await fixture("flood-stop");
    helper.stdout.resume();
    helper.stderr.resume();
    const port = await unusedPort();
    const exited = once(helper, "exit");
    sendStart(helper, {
      requestId: "flood-stop",
      root,
      runtimeRoot,
      port,
      script: `const net=require('node:net');const s=net.createServer();s.listen(${port},'127.0.0.1',()=>{const b=Buffer.alloc(10240,120);setInterval(()=>process.stdout.write(b),1)});`,
    });
    await vi.waitFor(() => {
      expect(lifecycle.some((frame) => frame.type === (process.platform === "darwin" ? "listener-verified" : "spawned"))).toBe(true);
    }, { timeout: 3_000 });
    const admittedAt = performance.now();
    helper.send({ type: "stop", protocolVersion: { major: 1, minor: 0 }, requestId: "flood-stop" });
    await vi.waitFor(() => {
      expect(lifecycle.some((frame) => frame.type === "stop-accepted")).toBe(true);
    }, { timeout: 250, interval: 5 });
    const stopAdmissionLatencyMs = performance.now() - admittedAt;
    await vi.waitFor(() => expect(lifecycle.some((frame) => frame.type === "stopped")).toBe(true), { timeout: 3_000 });
    const [code] = await exited as [number | null];
    expect(code).toBe(0);
    expect(stopAdmissionLatencyMs).toBeLessThan(250);
    expect(lifecycle.filter((frame) => frame.type === "terminal")).toEqual([
      expect.objectContaining({ status: "succeeded", cleanupProven: true }),
    ]);
    expect(lifecycle.filter((frame) => frame.type === "terminal")[0]).not.toHaveProperty("errorCode", "descendant_cleanup");
  });

  nativeOnly("treats repeated Stop as one idempotent cleanup operation", async () => {
    const { root, runtimeRoot, helper, lifecycle } = await fixture("repeated-stop");
    helper.stdout.resume();
    helper.stderr.resume();
    const port = await unusedPort();
    const exited = once(helper, "exit");
    sendStart(helper, {
      requestId: "repeated-stop",
      root,
      runtimeRoot,
      port,
      script: `const net=require('node:net');const s=net.createServer();s.listen(${port},'127.0.0.1');setInterval(()=>{},1000);`,
    });
    await vi.waitFor(
      () => expect(lifecycle.some((frame) => frame.type === (process.platform === "darwin" ? "listener-verified" : "spawned"))).toBe(true),
      { timeout: 3_000 },
    );
    const stop = { type: "stop", protocolVersion: { major: 1, minor: 0 }, requestId: "repeated-stop" };
    helper.send(stop);
    helper.send(stop);
    const [code] = await exited as [number | null];
    expect(code).toBe(0);
    expect(lifecycle.filter((frame) => frame.type === "stop-accepted")).toHaveLength(1);
    expect(lifecycle.filter((frame) => frame.type === "stopped")).toHaveLength(1);
    expect(lifecycle.filter((frame) => frame.type === "terminal")).toEqual([
      expect.objectContaining({ status: "succeeded", cleanupProven: true, receiptWritten: true }),
    ]);
    const receipt = JSON.parse(
      await readFile(path.join(runtimeRoot, "repeated-stop", "terminal-receipt.json"), "utf8"),
    ) as { terminal?: { status?: string; cleanupProven?: boolean } };
    expect(receipt.terminal).toMatchObject({ status: "succeeded", cleanupProven: true });
  });

  nativeOnly("does not permit a Node duplicate after post-spawn native setup failure", async () => {
    const previousInjection = process.env.RUDDER_PROCESS_HOST_TEST_PROCESS_SETUP_FAILURE;
    process.env.RUDDER_PROCESS_HOST_TEST_PROCESS_SETUP_FAILURE = "after_spawn";
    try {
      const { root, runtimeRoot, helper, lifecycle } = await fixture("post-spawn-setup-failure");
      const exited = once(helper, "exit");
      sendStart(helper, {
        requestId: "post-spawn-setup-failure",
        root,
        runtimeRoot,
        port: await unusedPort(),
        script: "setInterval(()=>{},1000);",
      });
      const [code] = await exited as [number | null];
      expect(code).toBe(1);
      expect(lifecycle).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "accepted" }),
        expect.objectContaining({ type: "terminal", status: "failed", errorCode: "process_setup_failed" }),
      ]));
      expect(lifecycle.filter((frame) => frame.type === "accepted")).toHaveLength(1);
    } finally {
      if (previousInjection === undefined) delete process.env.RUDDER_PROCESS_HOST_TEST_PROCESS_SETUP_FAILURE;
      else process.env.RUDDER_PROCESS_HOST_TEST_PROCESS_SETUP_FAILURE = previousInjection;
    }
  });

  macNativeOnly("fails closed when the requested listener belongs to a foreign process", async () => {
    const foreign = createServer();
    await new Promise<void>((resolve, reject) => {
      foreign.once("error", reject);
      foreign.listen(0, "127.0.0.1", resolve);
    });
    const address = foreign.address();
    if (!address || typeof address === "string") throw new Error("No foreign port");
    const { root, runtimeRoot, helper, lifecycle } = await fixture("foreign-listener");
    const exited = once(helper, "exit");
    sendStart(helper, {
      requestId: "foreign-listener",
      root,
      runtimeRoot,
      port: address.port,
      script: "setInterval(()=>{},1000);",
    });
    const [code] = await exited as [number | null];
    await new Promise<void>((resolve, reject) => foreign.close((error) => error ? reject(error) : resolve()));
    expect(code).toBe(1);
    expect(lifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "terminal", status: "failed", errorCode: "listener_owner_mismatch", cleanupProven: true }),
    ]));
    const receipt = JSON.parse(await readFile(path.join(runtimeRoot, "foreign-listener", "terminal-receipt.json"), "utf8")) as { terminal?: { errorCode?: string } };
    expect(receipt.terminal?.errorCode).toBe("listener_owner_mismatch");
  });

  nativeOnly("treats command EOF as cleanup without confusing raw-channel EOF", async () => {
    const { root, runtimeRoot, helper, lifecycle } = await fixture("command-eof");
    helper.stdout.resume();
    helper.stderr.resume();
    const exited = once(helper, "exit");
    sendStart(helper, {
      requestId: "command-eof",
      root,
      runtimeRoot,
      port: await unusedPort(),
      script: "const b=Buffer.alloc(10240,120);setInterval(()=>process.stdout.write(b),1);",
    });
    await vi.waitFor(() => expect(lifecycle.some((frame) => frame.type === "spawned")).toBe(true));
    helper.stdin.end();
    const [code] = await exited as [number | null];
    expect(code).toBe(0);
    expect(lifecycle.filter((frame) => frame.type === "terminal")).toEqual([
      expect.objectContaining({ status: "succeeded", cleanupProven: true }),
    ]);
    expect(lifecycle.filter((frame) => frame.type === "terminal")[0]).not.toHaveProperty("errorCode", "descendant_cleanup");
  });

  nativeOnly.each(["../outside", "nested/path", "nested\\path"])(
    "rejects unsafe owner token %s before any filesystem side effect",
    async (ownerToken) => {
      const { root, runtimeRoot, helper, lifecycle } = await fixture("unsafe-owner");
      const outside = path.join(root, "outside");
      const exited = once(helper, "exit");
      helper.send({
        type: "start",
        protocolVersion: { major: 1, minor: 0 },
        requestId: "unsafe-owner",
        executable: process.execPath,
        argv: ["-e", "process.exit(0)"],
        cwd: root,
        env: {},
        ownerToken,
        port: await unusedPort(),
        runtimeRoot,
      });
      const [code] = await exited as [number | null];
      expect(code).toBe(3);
      expect(lifecycle).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "error", errorCode: "invalid_owner_token" }),
      ]));
      await expect(access(outside)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  nativeOnly.each(["directory", "symlink"])(
    "does not overwrite a pre-existing %s operation root",
    async (kind) => {
      const { root, runtimeRoot, helper, lifecycle } = await fixture(`existing-${kind}`);
      const generation = `existing-${kind}-generation`;
      const operationRoot = path.join(runtimeRoot, generation);
      const marker = path.join(root, `${kind}-marker`);
      await writeFile(marker, "preserve", "utf8");
      if (kind === "directory") {
        await mkdir(operationRoot);
        await writeFile(path.join(operationRoot, "marker"), "preserve", "utf8");
      } else {
        await symlink(root, operationRoot, process.platform === "win32" ? "junction" : undefined);
      }
      const exited = once(helper, "exit");
      sendStart(helper, {
        requestId: generation,
        root,
        runtimeRoot,
        port: await unusedPort(),
        script: "setInterval(()=>{},1000);",
      });
      const [code] = await exited as [number | null];
      expect(code).toBe(1);
      expect(lifecycle).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "terminal", status: "failed", errorCode: "operation_root_unavailable" }),
      ]));
      await expect(readFile(marker, "utf8")).resolves.toBe("preserve");
      if (kind === "directory") {
        await expect(readFile(path.join(operationRoot, "marker"), "utf8")).resolves.toBe("preserve");
      }
    },
  );

  permissionNativeOnly("reports one failed terminal when durable receipt writing fails", async () => {
    const { root, runtimeRoot, helper, lifecycle } = await fixture("receipt-failure");
    helper.stdout.resume();
    helper.stderr.resume();
    const port = await unusedPort();
    const exited = once(helper, "exit");
    sendStart(helper, {
      requestId: "receipt-failure",
      root,
      runtimeRoot,
      port,
      script: `const net=require('node:net');const s=net.createServer();s.listen(${port},'127.0.0.1');setInterval(()=>{},1000);`,
    });
    await vi.waitFor(
      () => expect(lifecycle.some((frame) => frame.type === (process.platform === "darwin" ? "listener-verified" : "spawned"))).toBe(true),
      { timeout: 3_000 },
    );
    const operationRoot = path.join(runtimeRoot, "receipt-failure");
    await chmod(operationRoot, 0o500);
    helper.send({ type: "stop", protocolVersion: { major: 1, minor: 0 }, requestId: "receipt-failure" });
    const [code] = await exited as [number | null];
    await chmod(operationRoot, 0o700);
    expect(code).toBe(1);
    expect(lifecycle.filter((frame) => frame.type === "terminal")).toEqual([
      expect.objectContaining({
        status: "failed",
        errorCode: "receipt_write_failed",
        cleanupProven: true,
        receiptWritten: false,
      }),
    ]);
    await expect(access(path.join(operationRoot, "terminal-receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
