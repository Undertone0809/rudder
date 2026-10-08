import { resolveRudderNativeTarget } from "@rudderhq/shared";
import type { Request } from "express";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRustActorEnvelope,
  createRustFoundationBridge,
  type RustFoundationBridge,
  type RustPublicIngressOptions,
} from "./rust-foundation-bridge.js";

vi.mock("node:url", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:url")>();
  return { ...actual, fileURLToPath: vi.fn(actual.fileURLToPath) };
});

type FixtureMode = "invalid" | "not-ready" | "ready" | "ignore-term" | "public-ready" | "delayed"
  | "stream-missing-terminal" | "stream-bad-checksum" | "stream-transport-error"
  | "stream-invalid-json" | "stream-invalid-frame" | "stream-invalid-utf8"
  | "stream-wrong-content-type" | "stream-count-mismatch";

type Fixture = {
  binaryPath: string;
  modePath: string;
  pidPath: string;
  envPath: string;
  requestPath: string;
  setMode(mode: FixtureMode): Promise<void>;
  readEnv(): Promise<Record<string, string>>;
  readPid(): Promise<number>;
  readRequest(): Promise<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>;
  remove(): Promise<void>;
};

const activeBridges = new Set<RustFoundationBridge>();
const activeFixtures = new Set<Fixture>();

function fixtureSource(modePath: string, pidPath: string, envPath: string, requestPath: string) {
  return `#!${process.execPath}
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const mode = fs.readFileSync(${JSON.stringify(modePath)}, "utf8").trim();
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify(process.env));
let server = null;
let publicServer = null;
const shutdown = () => {
  publicServer?.closeAllConnections?.();
  publicServer?.close();
  if (!server) {
    process.exit(0);
    return;
  }
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", () => {
  if (mode !== "ignore-term") shutdown();
});
if (mode === "invalid") {
  process.stdout.write("not-json\\n");
} else {
  server = http.createServer((req, res) => {
    if (req.url === "/readyz") {
      res.statusCode = mode === "not-ready" ? 503 : 200;
      res.end(mode === "not-ready" ? "not ready" : "ready");
      return;
    }
    if (req.url?.includes("/project-reads") || req.url?.includes("/goal-reads") || req.url?.includes("/members") || req.url?.includes("/workspace/backups") || req.url?.includes("/branding") || req.url?.includes("/goal-set") || req.url?.includes("/resources/") || req.method === "DELETE" || (req.method === "POST" && req.url?.endsWith("/projects"))) {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        fs.writeFileSync(${JSON.stringify(requestPath)}, JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
        if (req.url?.includes("/workspace/backups")) {
          const rowFrame = JSON.stringify({ type: "backup", backup: { id: "fixture-backup" } }) + "\\n";
          const checksum = crypto.createHash("sha256").update(rowFrame, "utf8").digest("hex");
          res.setHeader("content-type", "application/x-rudder-workspace-backup-list+ndjson");
          if (mode === "stream-wrong-content-type") {
            res.setHeader("content-type", "application/json");
            res.end(rowFrame);
            return;
          }
          if (mode === "stream-invalid-json") {
            res.end("{not-json}\\n");
            return;
          }
          if (mode === "stream-invalid-frame") {
            res.end(JSON.stringify({ type: "backup", backup: [] }) + "\\n");
            return;
          }
          if (mode === "stream-invalid-utf8") {
            res.end(Buffer.from([0xff, 0x0a]));
            return;
          }
          if (mode === "stream-transport-error") {
            res.write(rowFrame);
            res.destroy();
            return;
          }
          if (mode === "stream-missing-terminal") {
            res.end(rowFrame);
            return;
          }
          const terminalChecksum = mode === "stream-bad-checksum" ? "0".repeat(64) : checksum;
          const terminalCount = mode === "stream-count-mismatch" ? 2 : 1;
          const finish = () => res.end(rowFrame + JSON.stringify({ type: "end", count: terminalCount, sha256: terminalChecksum }) + "\\n");
          if (mode === "delayed") setTimeout(finish, 75);
          else finish();
          return;
        }
        res.setHeader("content-type", "application/json");
        if (req.method === "POST" && !req.url?.includes("/project-reads") && !req.url?.includes("/goal-reads")) res.statusCode = 201;
        const finish = () => res.end(JSON.stringify({ status: "accepted" }));
        if (mode === "delayed") setTimeout(finish, 75);
        else finish();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") process.exit(2);
    const receipt = {
      boundAddr: "127.0.0.1:" + address.port,
      publicListener: false,
      productWriteAuthority: false,
    };
    const emit = () => process.stdout.write(JSON.stringify(receipt) + "\\n");
    if (mode === "public-ready") {
      publicServer = http.createServer((req, res) => res.end("ready"));
      publicServer.listen(0, "127.0.0.1", () => {
        receipt.publicIngress = { boundAddr: "127.0.0.1:" + publicServer.address().port, publicListener: true };
        emit();
      });
    } else emit();
  });
}
setInterval(() => {}, 1000);
`;
}

async function createFixture(initialMode: FixtureMode, executable = true): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "rudder-rust-foundation-bridge-"));
  const binaryPath = join(root, "fixture-server-foundation");
  const modePath = join(root, "mode");
  const pidPath = join(root, "pid");
  const envPath = join(root, "env.json");
  const requestPath = join(root, "request.json");
  await writeFile(modePath, `${initialMode}\n`, "utf8");
  await writeFile(binaryPath, fixtureSource(modePath, pidPath, envPath, requestPath), "utf8");
  await chmod(binaryPath, executable ? 0o755 : 0o644);
  const fixture: Fixture = {
    binaryPath,
    modePath,
    pidPath,
    envPath,
    requestPath,
    setMode: (mode) => writeFile(modePath, `${mode}\n`, "utf8"),
    readEnv: async () => JSON.parse(await readFile(envPath, "utf8")) as Record<string, string>,
    readPid: async () => Number((await readFile(pidPath, "utf8")).trim()),
    readRequest: async () => JSON.parse(await readFile(requestPath, "utf8")) as {
      method: string;
      url: string;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    },
    remove: () => rm(root, { recursive: true, force: true }),
  };
  activeFixtures.add(fixture);
  return fixture;
}

function createBridge(
  fixture: Fixture,
  options: {
    mode?: "off" | "shadow" | "required";
    organizationBrandingMode?: "off" | "shadow" | "required";
    projectGoalSetMode?: "off" | "shadow" | "required";
    publicIngress?: RustPublicIngressOptions;
    requestTimeoutMs?: number;
    workspaceBackupListTimeoutMs?: number;
  } = {},
) {
  const bridge = createRustFoundationBridge({
    databaseUrl: "postgres://bridge-test",
    mode: options.mode ?? "required",
    organizationBrandingMode: options.organizationBrandingMode ?? "off",
    projectGoalSetMode: options.projectGoalSetMode ?? "off",
    binaryPath: fixture.binaryPath,
    actorEnvelopeKey: "bridge-test-secret",
    requestTimeoutMs: options.requestTimeoutMs ?? 25,
    workspaceBackupListTimeoutMs: options.workspaceBackupListTimeoutMs,
    publicIngress: options.publicIngress,
  });
  activeBridges.add(bridge);
  return bridge;
}

type ExpectedEnvelopeInput = Omit<
  Parameters<typeof createRustActorEnvelope>[0],
  "secret" | "requestId" | "nonce" | "nowSeconds"
>;

function expectEnvelopeSignedWith(
  captured: Awaited<ReturnType<Fixture["readRequest"]>>,
  expected: ExpectedEnvelopeInput,
  secret: string,
) {
  const envelope = JSON.parse(String(captured.headers["x-rudder-actor-envelope"]));
  expect(envelope).toEqual(createRustActorEnvelope({
    ...expected,
    secret,
    requestId: envelope.requestId,
    nonce: envelope.nonce,
    nowSeconds: envelope.expiresAt - 60,
  }));
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} did not exit within ${timeoutMs}ms`);
}

afterEach(async () => {
  await Promise.allSettled([...activeBridges].map((bridge) => bridge.close()));
  activeBridges.clear();
  await Promise.all([...activeFixtures].map((fixture) => fixture.remove()));
  activeFixtures.clear();
});

describe("rust foundation bridge lifecycle", () => {
  it("binds workspace backup listing to the Board actor, organization and private Rust route", async () => {
    const fixture = await createFixture("ready");
    const bridge = createBridge(fixture);
    const orgId = "organization-backup-list";
    const actor = {
      type: "board" as const,
      userId: "board-user",
      source: "local_implicit" as const,
      sessionId: "board-session",
      authEpoch: 7,
    };
    const req = { actor } as unknown as Request;

    await bridge.start();
    const response = await bridge.workspaceBackupList(req, orgId);
    const captured = await fixture.readRequest();
    const requestPath = `/internal/orgs/${encodeURIComponent(orgId)}/workspace/backups`;

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("application/json");
    expect(JSON.parse(response.body.toString("utf8"))).toEqual({ backups: [{ id: "fixture-backup" }] });
    expect(captured.method).toBe("GET");
    expect(captured.url).toBe(requestPath);
    expectEnvelopeSignedWith(captured, {
      actor,
      organizationId: orgId,
      method: "GET",
      path: requestPath,
      action: "organization.workspace.backups.list",
      body: Buffer.alloc(0),
    }, "bridge-test-secret");
  });

  it.each([
    "stream-missing-terminal",
    "stream-bad-checksum",
    "stream-transport-error",
    "stream-invalid-json",
    "stream-invalid-frame",
    "stream-invalid-utf8",
    "stream-wrong-content-type",
    "stream-count-mismatch",
  ] as const)("rejects %s before exposing a partial public response", async (mode) => {
    const fixture = await createFixture(mode);
    const bridge = createBridge(fixture, { requestTimeoutMs: 1_000 });
    const req = {
      actor: {
        type: "board" as const,
        userId: "board-user",
        source: "local_implicit" as const,
        sessionId: "board-session",
        authEpoch: 7,
      },
    } as unknown as Request;

    await bridge.start();
    await expect(bridge.workspaceBackupList(req, "organization-backup-list"))
      .rejects.toMatchObject({ code: "request_failed" });
  });

  it("uses the dedicated workspace-backup-list timeout without extending Project creation", async () => {
    const fixture = await createFixture("delayed");
    const bridge = createBridge(fixture, {
      projectGoalSetMode: "required",
      requestTimeoutMs: 20,
      workspaceBackupListTimeoutMs: 500,
    });
    const actor = {
      type: "board" as const,
      userId: "board-user",
      source: "local_implicit" as const,
      sessionId: "board-session",
      authEpoch: 7,
    };

    await bridge.start();
    await expect(bridge.workspaceBackupList({ actor } as unknown as Request, "organization-backup-list"))
      .resolves.toMatchObject({ status: 200 });
    await expect(bridge.projectCreate(
      actor,
      "organization-project-create",
      { name: "slow project" },
      "idempotency-key",
      {},
      { organizationWorkspaceRoot: "/tmp/org", projectCreateStateRoot: "/tmp/state" },
    )).rejects.toMatchObject({ code: "request_failed" });
  });

  it("fails delayed workspace-backup-list requests at their configured timeout", async () => {
    const fixture = await createFixture("delayed");
    const bridge = createBridge(fixture, { requestTimeoutMs: 500, workspaceBackupListTimeoutMs: 20 });
    const req = {
      actor: {
        type: "board" as const,
        userId: "board-user",
        source: "local_implicit" as const,
        sessionId: "board-session",
        authEpoch: 7,
      },
    } as unknown as Request;

    await bridge.start();
    await expect(bridge.workspaceBackupList(req, "organization-backup-list"))
      .rejects.toMatchObject({ code: "request_failed" });
  });

  it("owns an explicitly requested public listener and clears its identity on shutdown", async () => {
    const fixture = await createFixture("public-ready");
    const publicIngress = {
      listenAddr: "127.0.0.1:0",
      nodeUpstream: "http://127.0.0.1:3101",
      authorizationKey: "0123456789abcdef0123456789abcdef",
      trustedProxies: "192.0.2.1,::1",
    };
    const bridge = createBridge(fixture, { mode: "off", publicIngress });
    expect(bridge.requiresStartup).toBe(true);
    await bridge.start();
    expect(bridge.publicIngressBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(bridge.waitForPublicIngressReady!()).resolves.toBeUndefined();
    expect(await fixture.readEnv()).toMatchObject({
      RUDDER_NATIVE_PUBLIC_LISTEN: publicIngress.listenAddr,
      RUDDER_NATIVE_NODE_UPSTREAM: publicIngress.nodeUpstream,
      RUDDER_NATIVE_INGRESS_AUTH_KEY: publicIngress.authorizationKey,
      RUDDER_NATIVE_INGRESS_TRUSTED_PROXIES: publicIngress.trustedProxies,
    });
    await bridge.close();
    expect(bridge.publicIngressBaseUrl).toBeNull();
    await expect(bridge.waitForPublicIngressReady!()).rejects.toMatchObject({ code: "not_ready" });
  });

  it("rejects a missing, unexpected or wrong public listener instead of accepting private readiness", async () => {
    for (const [mode, listenAddr] of [["ready", "127.0.0.1:0"], ["public-ready", "127.0.0.1:1"]] as const) {
      const fixture = await createFixture(mode);
      const bridge = createBridge(fixture, { publicIngress: {
        listenAddr, nodeUpstream: "http://127.0.0.1:3101",
        authorizationKey: "0123456789abcdef0123456789abcdef",
      } });
      await expect(bridge.start()).rejects.toMatchObject({ code: "startup_failed" });
      expect(bridge.publicIngressBaseUrl).toBeNull();
    }
    const fixture = await createFixture("public-ready");
    await expect(createBridge(fixture).start()).rejects.toMatchObject({ code: "startup_failed" });
  });

  it("defaults member reads and Project-Goal writes to required while Project reads always require startup", () => {
    const names = [
      "RUDDER_RUST_MEMBER_DIRECTORY_MODE",
      "RUDDER_RUST_ORGANIZATION_BRANDING_MODE",
      "RUDDER_RUST_PROJECT_GOAL_SET_MODE",
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];

    try {
      const defaultBridge = createRustFoundationBridge({ databaseUrl: "postgres://bridge-test" });
      activeBridges.add(defaultBridge);
      expect(defaultBridge.mode).toBe("required");
      expect(defaultBridge.organizationBrandingMode).toBe("off");
      expect(defaultBridge.projectGoalSetMode).toBe("required");
      expect(defaultBridge.requiresStartup).toBe(true);

      const disabledBridge = createRustFoundationBridge({
        databaseUrl: "postgres://bridge-test",
        mode: "off",
        projectGoalSetMode: "off",
      });
      activeBridges.add(disabledBridge);
      expect(disabledBridge.mode).toBe("off");
      expect(disabledBridge.requiresStartup).toBe(true);
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("passes only the foundation startup environment to the child", async () => {
    const previousEnv = {
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      DATABASE_URL: process.env.DATABASE_URL,
      RUDDER_PRIVATE_TEST_SECRET: process.env.RUDDER_PRIVATE_TEST_SECRET,
    };
    process.env.AWS_SECRET_ACCESS_KEY = "should-not-reach-rust";
    process.env.DATABASE_URL = "postgres://unrelated-parent-secret";
    process.env.RUDDER_PRIVATE_TEST_SECRET = "should-not-reach-rust-either";

    try {
      const fixture = await createFixture("ready");
      const bridge = createBridge(fixture);

      await expect(bridge.start()).resolves.toBeUndefined();
      const childEnv = await fixture.readEnv();
      const requiredEnv = {
        RUDDER_NATIVE_ACTOR_ENVELOPE_KEY: "bridge-test-secret",
        RUDDER_NATIVE_DATABASE_REQUIRED: "true",
        RUDDER_NATIVE_DATABASE_URL: "postgres://bridge-test",
        RUDDER_NATIVE_LISTEN: "127.0.0.1:0",
      };
      expect(childEnv).toMatchObject(requiredEnv);
      expect(Object.keys(childEnv).filter((name) => (
        !(name in requiredEnv) && name !== "__CF_USER_TEXT_ENCODING"
      ))).toEqual([]);
      expect(childEnv).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
      expect(childEnv).not.toHaveProperty("DATABASE_URL");
      expect(childEnv).not.toHaveProperty("RUDDER_PRIVATE_TEST_SECRET");
    } finally {
      for (const [name, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("cleans up an invalid receipt and allows the same bridge to retry", async () => {
    const fixture = await createFixture("invalid");
    const bridge = createBridge(fixture);

    await expect(bridge.start()).rejects.toMatchObject({ code: "startup_failed" });
    const failedPid = await fixture.readPid();
    await waitForProcessExit(failedPid);

    await fixture.setMode("ready");
    await expect(bridge.start()).resolves.toBeUndefined();
    const readyPid = await fixture.readPid();
    expect(readyPid).not.toBe(failedPid);
    await bridge.close();
    await waitForProcessExit(readyPid);
  });

  it("cleans up after a ready timeout and allows a retry", async () => {
    const fixture = await createFixture("not-ready");
    const bridge = createBridge(fixture);

    await expect(bridge.start()).rejects.toMatchObject({ code: "not_ready" });
    const failedPid = await fixture.readPid();
    await waitForProcessExit(failedPid);

    await fixture.setMode("ready");
    await expect(bridge.start()).resolves.toBeUndefined();
    const readyPid = await fixture.readPid();
    await bridge.close();
    await waitForProcessExit(readyPid);
  }, 15_000);

  it("fails closed for a non-executable binary and allows a retry", async () => {
    const fixture = await createFixture("ready", false);
    const bridge = createBridge(fixture);

    await expect(bridge.start()).rejects.toMatchObject({ code: "binary_unavailable" });

    await chmod(fixture.binaryPath, 0o755);
    await expect(bridge.start()).resolves.toBeUndefined();
    const readyPid = await fixture.readPid();
    await bridge.close();
    await waitForProcessExit(readyPid);
  });

  it("fails closed for a missing explicit path even when the default debug binary exists", async () => {
    const fixture = await createFixture("ready");
    const root = dirname(fixture.binaryPath);
    const debugDirectory = join(root, "native", "target", "debug");
    const defaultDebugBinary = join(debugDirectory, "rudder-server-foundation");
    await mkdir(debugDirectory, { recursive: true });
    await copyFile(fixture.binaryPath, defaultDebugBinary);
    await chmod(defaultDebugBinary, 0o755);
    const target = resolveRudderNativeTarget();
    expect(target).not.toBeNull();
    const installedDirectory = join(root, "server", "resources", "native", target!);
    await mkdir(installedDirectory, { recursive: true });
    const installedBinaryPath = join(
      installedDirectory,
      process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation",
    );
    await copyFile(fixture.binaryPath, installedBinaryPath);
    await chmod(installedBinaryPath, 0o755);

    const originalFileURLToPath = vi.mocked(fileURLToPath).getMockImplementation()!;
    const bridgeModuleUrl = new URL("./rust-foundation-bridge.ts", import.meta.url).href;
    vi.mocked(fileURLToPath).mockImplementation((path, options) => (
      path.toString() === bridgeModuleUrl
        ? join(root, "server", "src", "services", "rust-foundation-bridge.ts")
        : originalFileURLToPath(path, options)
    ));
    const previousPath = process.env.RUDDER_SERVER_FOUNDATION_PATH;

    try {
      delete process.env.RUDDER_SERVER_FOUNDATION_PATH;
      await rm(installedBinaryPath);
      const fallbackBridge = createRustFoundationBridge({
        databaseUrl: "postgres://bridge-test",
        mode: "required",
        actorEnvelopeKey: "bridge-test-secret",
      });
      activeBridges.add(fallbackBridge);
      await expect(fallbackBridge.start()).resolves.toBeUndefined();
      expect(fileURLToPath).toHaveBeenCalledWith(bridgeModuleUrl);
      const fallbackPid = await fixture.readPid();
      await fallbackBridge.close();
      await waitForProcessExit(fallbackPid);

      await copyFile(fixture.binaryPath, installedBinaryPath);
      await chmod(installedBinaryPath, 0o755);
      vi.mocked(fileURLToPath).mockClear();
      process.env.RUDDER_SERVER_FOUNDATION_PATH = join(root, "rudder-server-foundation-missing");
      const bridge = createRustFoundationBridge({
        databaseUrl: "postgres://bridge-test",
        mode: "required",
        actorEnvelopeKey: "bridge-test-secret",
      });
      activeBridges.add(bridge);

      await expect(bridge.start()).rejects.toMatchObject({ code: "binary_unavailable" });
      // An explicit path must not even resolve the repository's default binary paths.
      expect(fileURLToPath).not.toHaveBeenCalledWith(bridgeModuleUrl);
    } finally {
      vi.mocked(fileURLToPath).mockImplementation(originalFileURLToPath);
      if (previousPath === undefined) delete process.env.RUDDER_SERVER_FOUNDATION_PATH;
      else process.env.RUDDER_SERVER_FOUNDATION_PATH = previousPath;
    }
  });

  it("uses only the packaged asset in compiled server layouts and fails closed without it", async () => {
    const fixture = await createFixture("ready");
    const target = resolveRudderNativeTarget();
    expect(target).not.toBeNull();
    const serverPackageRoot = join(dirname(fixture.binaryPath), "bundle", "server");
    const serverTsconfig = JSON.parse(await readFile(new URL("../../tsconfig.json", import.meta.url), "utf8")) as {
      compilerOptions: { outDir: string };
    };
    const bundledModulePath = join(
      serverPackageRoot,
      serverTsconfig.compilerOptions.outDir,
      "services",
      "rust-foundation-bridge.js",
    );
    const binaryName = process.platform === "win32"
      ? "rudder-server-foundation.exe"
      : "rudder-server-foundation";
    const installedBinaryPath = join(serverPackageRoot, "resources", "native", target!, binaryName);
    await mkdir(dirname(installedBinaryPath), { recursive: true });
    await copyFile(fixture.binaryPath, installedBinaryPath);
    await chmod(installedBinaryPath, 0o755);
    const ancestorDebugBinaryPath = join(
      dirname(serverPackageRoot),
      "native",
      "target",
      "debug",
      binaryName,
    );
    const ancestorFixture = await createFixture("ready");
    await mkdir(dirname(ancestorDebugBinaryPath), { recursive: true });
    await copyFile(ancestorFixture.binaryPath, ancestorDebugBinaryPath);
    await chmod(ancestorDebugBinaryPath, 0o755);

    const originalFileURLToPath = vi.mocked(fileURLToPath).getMockImplementation()!;
    const bridgeModuleUrl = new URL("./rust-foundation-bridge.ts", import.meta.url).href;
    const previousPath = process.env.RUDDER_SERVER_FOUNDATION_PATH;

    try {
      delete process.env.RUDDER_SERVER_FOUNDATION_PATH;
      vi.mocked(fileURLToPath).mockImplementation((path, options) => (
        path.toString() === bridgeModuleUrl
          ? bundledModulePath
          : originalFileURLToPath(path, options)
      ));

      const bridge = createRustFoundationBridge({
        databaseUrl: "postgres://bridge-test",
        mode: "required",
        actorEnvelopeKey: "bridge-test-secret",
      });
      activeBridges.add(bridge);
      await expect(bridge.start()).resolves.toBeUndefined();
      const pid = await fixture.readPid();
      await expect(readFile(ancestorFixture.pidPath, "utf8")).rejects.toThrow();
      await bridge.close();
      await waitForProcessExit(pid);
      expect(fileURLToPath).toHaveBeenCalledWith(bridgeModuleUrl);

      await rm(installedBinaryPath);
      const missingAssetBridge = createRustFoundationBridge({
        databaseUrl: "postgres://bridge-test",
        mode: "required",
        actorEnvelopeKey: "bridge-test-secret",
      });
      activeBridges.add(missingAssetBridge);
      await expect(missingAssetBridge.start()).rejects.toMatchObject({ code: "binary_unavailable" });
      await expect(readFile(ancestorFixture.pidPath, "utf8")).rejects.toThrow();
    } finally {
      vi.mocked(fileURLToPath).mockImplementation(originalFileURLToPath);
      if (previousPath === undefined) delete process.env.RUDDER_SERVER_FOUNDATION_PATH;
      else process.env.RUDDER_SERVER_FOUNDATION_PATH = previousPath;
    }
  });

  it("captures one generated signer for child startup and every signed request", async () => {
    const previousKey = process.env.RUDDER_NATIVE_ACTOR_ENVELOPE_KEY;
    delete process.env.RUDDER_NATIVE_ACTOR_ENVELOPE_KEY;

    try {
      const fixture = await createFixture("ready");
      const bridge = createRustFoundationBridge({
        databaseUrl: "postgres://bridge-test",
        mode: "required",
        organizationBrandingMode: "required",
        projectGoalSetMode: "required",
        binaryPath: fixture.binaryPath,
        requestTimeoutMs: 25,
      });
      activeBridges.add(bridge);
      process.env.RUDDER_NATIVE_ACTOR_ENVELOPE_KEY = "changed-after-bridge-creation";

      await bridge.start();
      const signer = (await fixture.readEnv()).RUDDER_NATIVE_ACTOR_ENVELOPE_KEY;
      expect(signer).toMatch(/^[a-f0-9]{64}$/);
      expect(signer).not.toBe(process.env.RUDDER_NATIVE_ACTOR_ENVELOPE_KEY);

      const readActor = {
        type: "agent" as const,
        source: "agent_key" as const,
        agentId: "agent-1",
        orgId: "org-1",
        sessionId: "member-directory-session",
        authEpoch: 3,
      };
      const memberPath = "/api/orgs/org-1/members/directory?limit=25";
      const readResponse = await bridge.memberDirectory({
        actor: readActor,
        originalUrl: memberPath,
        header: () => undefined,
      } as unknown as Request, "org-1");
      expect(readResponse.status).toBe(200);
      expectEnvelopeSignedWith(await fixture.readRequest(), {
        actor: readActor,
        organizationId: "org-1",
        method: "GET",
        path: memberPath,
        action: "organization.members.directory.read",
        body: Buffer.alloc(0),
      }, signer);

      const brandingBody = Buffer.from(JSON.stringify({ name: "Rudder" }), "utf8");
      const brandingPath = "/api/orgs/org-1/branding";
      const brandingActor = {
        type: "board" as const,
        source: "local_implicit" as const,
        userId: "user-1",
        sessionId: "branding-session",
        authEpoch: 4,
      };
      const brandingRequest = {
        actor: brandingActor,
        originalUrl: brandingPath,
        header(name: string) {
          return name.toLowerCase() === "x-rudder-idempotency-key"
            ? "branding-client-key"
            : "application/json";
        },
      } as unknown as Request;
      await bridge.organizationBranding(brandingRequest, "org-1", brandingBody);
      expectEnvelopeSignedWith(await fixture.readRequest(), {
        actor: brandingActor,
        organizationId: "org-1",
        method: "PATCH",
        path: brandingPath,
        action: "organization.branding.update",
        body: brandingBody,
        idempotencyKey: "branding-client-key",
      }, signer);

      const goalSetBody = Buffer.from(JSON.stringify({ goalIds: ["goal-1"] }), "utf8");
      const goalSetPath = "/api/orgs/org-1/projects/project-1/goal-set";
      const goalSetActor = {
        type: "agent" as const,
        source: "agent_key" as const,
        agentId: "agent-1",
        orgId: "org-1",
        sessionId: "goal-set-session",
        authEpoch: 5,
      };
      const goalSetRequest = {
        actor: goalSetActor,
        originalUrl: "/api/projects/project-1",
        header(name: string) {
          return name.toLowerCase() === "x-rudder-idempotency-key"
            ? "goal-set-client-key"
            : "application/json";
        },
      } as unknown as Request;
      await bridge.projectGoalSet(
        goalSetRequest,
        "org-1",
        "project-1",
        goalSetBody,
        goalSetPath,
      );
      expectEnvelopeSignedWith(await fixture.readRequest(), {
        actor: goalSetActor,
        organizationId: "org-1",
        method: "PATCH",
        path: goalSetPath,
        action: "project.goal_set.replace",
        body: goalSetBody,
        idempotencyKey: "goal-set-client-key",
      }, signer);

      const createData = { name: "Project", goalIds: [] };
      const createRoots = { organizationWorkspaceRoot: "/fixture/org", projectCreateStateRoot: "/fixture/instance/data" };
      const createResponse = await bridge.projectCreate(goalSetActor, "org-1", createData, "create-key", {}, createRoots);
      expect(createResponse.status).toBe(201);
      expectEnvelopeSignedWith(await fixture.readRequest(), {
        actor: goalSetActor,
        organizationId: "org-1",
        method: "POST",
        path: "/api/orgs/org-1/projects",
        action: "project.create",
        body: Buffer.from(JSON.stringify({ runId: null, data: createData, activityDetails: {}, ...createRoots })),
        idempotencyKey: "create-key",
      }, signer);

      process.env.RUDDER_NATIVE_ACTOR_ENVELOPE_KEY = "changed-before-bridge-restart";
      await bridge.close();
      await bridge.start();
      expect((await fixture.readEnv()).RUDDER_NATIVE_ACTOR_ENVELOPE_KEY).toBe(signer);
    } finally {
      if (previousKey === undefined) delete process.env.RUDDER_NATIVE_ACTOR_ENVELOPE_KEY;
      else process.env.RUDDER_NATIVE_ACTOR_ENVELOPE_KEY = previousKey;
    }
  });

  it("rotates the generated signer for each bridge instance", async () => {
    const previousKey = process.env.RUDDER_NATIVE_ACTOR_ENVELOPE_KEY;
    delete process.env.RUDDER_NATIVE_ACTOR_ENVELOPE_KEY;

    try {
      const fixture = await createFixture("ready");
      const firstBridge = createRustFoundationBridge({
        databaseUrl: "postgres://bridge-test",
        mode: "required",
        binaryPath: fixture.binaryPath,
      });
      activeBridges.add(firstBridge);
      process.env.RUDDER_NATIVE_ACTOR_ENVELOPE_KEY = "late-first-instance-key";
      await firstBridge.start();
      const firstSigner = (await fixture.readEnv()).RUDDER_NATIVE_ACTOR_ENVELOPE_KEY;
      expect(firstSigner).not.toBe("late-first-instance-key");
      await firstBridge.close();

      delete process.env.RUDDER_NATIVE_ACTOR_ENVELOPE_KEY;
      const secondBridge = createRustFoundationBridge({
        databaseUrl: "postgres://bridge-test",
        mode: "required",
        binaryPath: fixture.binaryPath,
      });
      activeBridges.add(secondBridge);
      process.env.RUDDER_NATIVE_ACTOR_ENVELOPE_KEY = "late-second-instance-key";
      await secondBridge.start();
      const secondSigner = (await fixture.readEnv()).RUDDER_NATIVE_ACTOR_ENVELOPE_KEY;
      expect(secondSigner).toMatch(/^[a-f0-9]{64}$/);
      expect(secondSigner).not.toBe(firstSigner);
      expect(secondSigner).not.toBe("late-second-instance-key");
    } finally {
      if (previousKey === undefined) delete process.env.RUDDER_NATIVE_ACTOR_ENVELOPE_KEY;
      else process.env.RUDDER_NATIVE_ACTOR_ENVELOPE_KEY = previousKey;
    }
  });

  it("serializes close behind start and waits for SIGKILL exit", async () => {
    const fixture = await createFixture("ignore-term");
    const bridge = createBridge(fixture);

    const startPromise = bridge.start();
    const closePromise = bridge.close();
    await expect(startPromise).resolves.toBeUndefined();
    const pid = await fixture.readPid();

    const closeResult = await Promise.race([
      closePromise.then(() => "closed"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]);
    expect(closeResult).toBe("pending");
    await expect(closePromise).resolves.toBeUndefined();
    await waitForProcessExit(pid);
  }, 10_000);

  it.each([
    { projectId: null, resourcesOnly: false },
    { projectId: "old-node-owned-project", resourcesOnly: false },
    { projectId: "new-rust-created-project", resourcesOnly: true },
  ])("signs API-wide Project reads with mutation modes disabled: %j", async (selection) => {
    const fixture = await createFixture("ready");
    const bridge = createBridge(fixture, { mode: "off", projectGoalSetMode: "off" });
    const actor = { type: "agent", agentId: "agent-1", orgId: "org-1", source: "agent_key" } as const;
    const input = { ...selection, organizationWorkspaceRoot: "/trusted/organization" };
    const response = await bridge.projectRead(actor, "org-1", input);
    expect(response.status).toBe(200);
    expect(bridge.requiresStartup).toBe(true);
    const captured = await fixture.readRequest();
    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("/internal/orgs/org-1/project-reads");
    expect(JSON.parse(captured.body)).toEqual(input);
    expect(captured.headers["x-rudder-idempotency-key"]).toBeUndefined();
    expectEnvelopeSignedWith(captured, {
      actor,
      organizationId: "org-1",
      method: "POST",
      path: captured.url,
      action: "project.read",
      body: Buffer.from(JSON.stringify(input)),
    }, "bridge-test-secret");
  });

  it.each([
    { goalId: null, view: "list" as const },
    { goalId: "old-node-owned-goal", view: "detail" as const },
    { goalId: "goal", view: "history" as const, limit: "7", cursor: "page-two" },
  ])("signs API-wide Goal reads with mutation modes disabled: %j", async (selection) => {
    const fixture = await createFixture("ready");
    const bridge = createBridge(fixture, { mode: "off", projectGoalSetMode: "off" });
    const actor = { type: "agent", agentId: "agent-1", orgId: "org-1", source: "agent_key" } as const;
    const input = selection;
    const response = await bridge.goalRead(actor, "org-1", input);
    expect(response.status).toBe(200);
    expect(bridge.requiresStartup).toBe(true);
    const captured = await fixture.readRequest();
    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("/internal/orgs/org-1/goal-reads");
    expect(JSON.parse(captured.body)).toEqual(input);
    expect(captured.headers["x-rudder-idempotency-key"]).toBeUndefined();
    expectEnvelopeSignedWith(captured, {
      actor,
      organizationId: "org-1",
      method: "POST",
      path: captured.url,
      action: "goal.read",
      body: Buffer.from(JSON.stringify(input)),
    }, "bridge-test-secret");
  });

  it("binds branding requests to the private Actix contract", async () => {
    const fixture = await createFixture("ready");
    const bridge = createBridge(fixture, { mode: "off", organizationBrandingMode: "required" });
    const body = Buffer.from(JSON.stringify({ name: "Renamed Rudder", brandColor: "#abcdef" }), "utf8");
    const req = {
      actor: {
        type: "board",
        source: "local_implicit",
        userId: "user-1",
        sessionId: "session-1",
        authEpoch: 4,
      },
      originalUrl: "/api/orgs/org-1/branding",
      header(name: string) {
        return name.toLowerCase() === "content-type"
          ? "application/json"
          : name.toLowerCase() === "x-rudder-idempotency-key"
            ? "branding-client-key"
            : undefined;
      },
    } as unknown as Request;

    const response = await bridge.organizationBranding(req, "org-1", body);
    expect(response.status).toBe(200);
    expect(bridge.requiresStartup).toBe(true);
    const captured = await fixture.readRequest();
    expect(captured.method).toBe("PATCH");
    expect(captured.url).toBe("/api/orgs/org-1/branding");
    expect(captured.body).toBe(body.toString("utf8"));
    expect(captured.headers["x-rudder-idempotency-key"]).toBe("branding-client-key");
    expect(captured.headers["content-type"]).toBe("application/json");
    const envelope = JSON.parse(String(captured.headers["x-rudder-actor-envelope"]));
    expect(envelope).toMatchObject({
      action: "organization.branding.update",
      method: "PATCH",
      organizationId: "org-1",
      actor: { kind: "user", id: "user-1" },
      sessionId: "session-1",
      authEpoch: 4,
    });
    expect(envelope.bodySha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(envelope.idempotencyKey).toBe("branding-client-key");
    expect(captured.headers["x-rudder-request-id"]).toBe(envelope.requestId);
  });

  it("signs Chat branding with the authenticated actor and stable idempotency key", async () => {
    const fixture = await createFixture("ready");
    const bridge = createBridge(fixture, { mode: "off", organizationBrandingMode: "required" });
    const actor = {
      type: "board" as const,
      source: "local_implicit" as const,
      userId: "user-1",
      sessionId: "chat-approval-session",
      authEpoch: 9,
    };
    const body = Buffer.from(JSON.stringify({ brandColor: "#123456" }), "utf8");
    const idempotencyKey = "approval-stable-key";

    const response = await bridge.organizationBrandingForActor(
      actor,
      "org-1",
      body,
      idempotencyKey,
    );

    expect(response.status).toBe(200);
    expect(bridge.requiresStartup).toBe(true);
    const captured = await fixture.readRequest();
    expect(captured.method).toBe("PATCH");
    expect(captured.url).toBe("/api/orgs/org-1/branding");
    expect(captured.body).toBe(body.toString("utf8"));
    expect(captured.headers["x-rudder-idempotency-key"]).toBe(idempotencyKey);
    expectEnvelopeSignedWith(captured, {
      actor,
      organizationId: "org-1",
      method: "PATCH",
      path: "/api/orgs/org-1/branding",
      action: "organization.branding.update",
      body,
      idempotencyKey,
    }, "bridge-test-secret");
  });

  it("identifies an invalid organization branding mode with its own environment variable", () => {
    expect(() => createRustFoundationBridge({
      databaseUrl: "postgres://bridge-test",
      mode: "off",
      organizationBrandingMode: "invalid" as never,
    })).toThrow("RUDDER_RUST_ORGANIZATION_BRANDING_MODE");
  });

  it("binds Project-Goal replacement requests to the private Actix contract", async () => {
    const fixture = await createFixture("ready");
    const bridge = createBridge(fixture, { mode: "off", projectGoalSetMode: "required" });
    const body = Buffer.from(JSON.stringify({
      goalIds: ["goal-1", "goal-2"],
      primaryGoalId: "goal-2",
    }), "utf8");
    const req = {
      actor: {
        type: "agent",
        source: "agent_key",
        agentId: "agent-1",
        orgId: "org-1",
        sessionId: "session-1",
        authEpoch: 3,
      },
      originalUrl: "/api/projects/project-1",
      header(name: string) {
        return name.toLowerCase() === "content-type"
          ? "application/json"
          : name.toLowerCase() === "x-rudder-idempotency-key"
            ? "project-goal-client-key"
            : undefined;
      },
    } as unknown as Request;

    const response = await bridge.projectGoalSet(
      req,
      "org-1",
      "project-1",
      body,
      "/api/orgs/org-1/projects/project-1/goal-set",
    );
    expect(response.status).toBe(200);
    expect(bridge.projectGoalSetMode).toBe("required");
    const captured = await fixture.readRequest();
    expect(captured.method).toBe("PATCH");
    expect(captured.url).toBe("/api/orgs/org-1/projects/project-1/goal-set");
    expect(captured.body).toBe(body.toString("utf8"));
    expect(captured.headers["x-rudder-idempotency-key"]).toBe("project-goal-client-key");
    const envelope = JSON.parse(String(captured.headers["x-rudder-actor-envelope"]));
    expect(envelope).toMatchObject({
      action: "project.goal_set.replace",
      method: "PATCH",
      organizationId: "org-1",
      actor: { kind: "agent", id: "agent-1" },
      sessionId: "session-1",
      authEpoch: 3,
    });
    expect(envelope.bodySha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(envelope.idempotencyKey).toBe("project-goal-client-key");
  });

  it("identifies an invalid Project-Goal mode with its own environment variable", () => {
    expect(() => createRustFoundationBridge({
      databaseUrl: "postgres://bridge-test",
      mode: "off",
      projectGoalSetMode: "invalid" as never,
    })).toThrow("RUDDER_RUST_PROJECT_GOAL_SET_MODE");
  });

  it.each(["update", "delete"] as const)("signs resource %s method, scope, payload and replay key", async (operation) => {
    const fixture = await createFixture("ready");
    const bridge = createBridge(fixture, { mode: "off", projectGoalSetMode: "required" });
    const actor = { type: "board", source: "session", userId: "user-1", sessionId: "session-1", authEpoch: 3 } as const;
    const req = { actor } as unknown as Request;
    const body = Buffer.from(JSON.stringify({ data: operation === "update" ? { title: "Updated resource" } : {}, runId: null }));
    const response = await bridge.organizationResourceMutation!(req, "org-1", "resource-1", operation, body, " resource-key ");
    expect(response.status).toBe(200);
    const captured = await fixture.readRequest();
    const method = operation === "update" ? "PATCH" : "DELETE";
    expect(captured.method).toBe(method);
    expect(captured.url).toBe("/api/orgs/org-1/resources/resource-1");
    expect(captured.body).toBe(body.toString());
    expect(captured.headers["x-rudder-idempotency-key"]).toBe("resource-key");
    expectEnvelopeSignedWith(captured, {
      actor, organizationId: "org-1", method, path: captured.url,
      action: "organization.resource.mutate", body, idempotencyKey: "resource-key",
    }, "bridge-test-secret");
  });

  it.each(["off", "shadow"] as const)("rejects resource writes in %s mode before startup", async (projectGoalSetMode) => {
    const bridge = createRustFoundationBridge({ databaseUrl: "", mode: "off", projectGoalSetMode });
    await expect(bridge.organizationResourceMutation!({ actor: { type: "board", source: "local_implicit" } } as unknown as Request,
      "org-1", "resource-1", "delete", Buffer.from(JSON.stringify({ data: {}, runId: null })), "resource-key"))
      .rejects.toMatchObject({ code: "request_failed" });
  });

  it("binds Project creation actor/run, payload, trusted roots and key to the captured signer", async () => {
    const fixture = await createFixture("ready");
    const bridge = createBridge(fixture, { mode: "off", projectGoalSetMode: "required" });
    const actor = { type: "agent", source: "agent_key", agentId: "agent-1", orgId: "org-1", runId: "run-1" } as const;
    const data = { name: "Release", goalIds: [], organizationWorkspaceRoot: "/untrusted" };
    const roots = { organizationWorkspaceRoot: "/trusted/org", projectCreateStateRoot: "/trusted/instance/data" };
    const activityDetails = { source: "fixture" };
    const response = await bridge.projectCreate(actor, "org-1", data, " create-key ", activityDetails, roots);
    expect(response.status).toBe(201);
    const captured = await fixture.readRequest();
    const body = Buffer.from(JSON.stringify({ runId: "run-1", data, activityDetails, ...roots }));
    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("/api/orgs/org-1/projects");
    expect(captured.body).toBe(body.toString());
    expect(captured.headers["x-rudder-idempotency-key"]).toBe("create-key");
    expectEnvelopeSignedWith(captured, {
      actor, organizationId: "org-1", method: "POST", path: captured.url,
      action: "project.create", body, idempotencyKey: "create-key",
    }, "bridge-test-secret");
  });

  it.each(["off", "shadow"] as const)("rejects Project creation in %s mode before startup", async (projectGoalSetMode) => {
    const bridge = createRustFoundationBridge({ databaseUrl: "", mode: "off", projectGoalSetMode });
    await expect(bridge.projectCreate({ type: "board", source: "local_implicit" }, "org-1", { name: "Release" }, "key", {},
      { organizationWorkspaceRoot: "/trusted/org", projectCreateStateRoot: "/trusted/data" }))
      .rejects.toMatchObject({ code: "request_failed" });
  });

  it("propagates Project creation startup failure", async () => {
    const bridge = createRustFoundationBridge({ databaseUrl: "", mode: "off", projectGoalSetMode: "required" });
    await expect(bridge.projectCreate({ type: "board", source: "local_implicit" }, "org-1", { name: "Release" }, "key", {},
      { organizationWorkspaceRoot: "/trusted/org", projectCreateStateRoot: "/trusted/data" }))
      .rejects.toMatchObject({ code: "database_unconfigured" });
  });

  it("binds Project DELETE to the signed private bridge contract", async () => {
    const fixture = await createFixture("ready");
    const bridge = createBridge(fixture, { mode: "off", projectGoalSetMode: "required" });
    const body = Buffer.from(JSON.stringify({ runId: "run-1" }), "utf8");
    const req = {
      actor: {
        type: "agent",
        source: "agent_key",
        agentId: "agent-1",
        orgId: "org-1",
        runId: "run-1",
        sessionId: "session-1",
        authEpoch: 3,
      },
      originalUrl: "/api/projects/project-1",
      header(name: string) {
        return name.toLowerCase() === "content-type" ? "application/json" : undefined;
      },
    } as unknown as Request;
    const requestPath = "/api/orgs/org-1/projects/project-1";

    const response = await bridge.projectDelete(
      req,
      "org-1",
      "project-1",
      body,
      "project-delete-client-key",
      requestPath,
    );

    expect(response.status).toBe(200);
    expect(bridge.projectGoalSetMode).toBe("required");
    expect(bridge.requiresStartup).toBe(true);
    const captured = await fixture.readRequest();
    expect(captured.method).toBe("DELETE");
    expect(captured.url).toBe(requestPath);
    expect(captured.body).toBe(body.toString("utf8"));
    expect(captured.headers["x-rudder-idempotency-key"]).toBe("project-delete-client-key");
    expect(captured.headers["content-type"]).toBe("application/json");
    expectEnvelopeSignedWith(captured, {
      actor: req.actor,
      organizationId: "org-1",
      method: "DELETE",
      path: requestPath,
      action: "project.delete",
      body,
      idempotencyKey: "project-delete-client-key",
    }, "bridge-test-secret");
  });

  it("does not activate Project DELETE from an independent undocumented mode", () => {
    const previousMode = process.env.RUDDER_RUST_PROJECT_DELETE_MODE;
    process.env.RUDDER_RUST_PROJECT_DELETE_MODE = "required";
    try {
      const bridge = createRustFoundationBridge({
        databaseUrl: "postgres://bridge-test",
        mode: "off",
        projectGoalSetMode: "off",
      });
      activeBridges.add(bridge);
      expect(bridge.projectGoalSetMode).toBe("off");
      expect(bridge.requiresStartup).toBe(true);
    } finally {
      if (previousMode === undefined) delete process.env.RUDDER_RUST_PROJECT_DELETE_MODE;
      else process.env.RUDDER_RUST_PROJECT_DELETE_MODE = previousMode;
    }
  });
});
