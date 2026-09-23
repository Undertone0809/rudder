import type { Request } from "express";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRustFoundationBridge,
  type RustFoundationBridge,
} from "./rust-foundation-bridge.js";

type FixtureMode = "invalid" | "not-ready" | "ready" | "ignore-term";

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
const mode = fs.readFileSync(${JSON.stringify(modePath)}, "utf8").trim();
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify(process.env));
let server = null;
const shutdown = () => {
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
    if (req.url?.includes("/branding") || req.url?.includes("/goal-set")) {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        fs.writeFileSync(${JSON.stringify(requestPath)}, JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "accepted" }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") process.exit(2);
    process.stdout.write(JSON.stringify({
      boundAddr: "127.0.0.1:" + address.port,
      publicListener: false,
      productWriteAuthority: false,
    }) + "\\n");
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
  } = {},
) {
  const bridge = createRustFoundationBridge({
    databaseUrl: "postgres://bridge-test",
    mode: options.mode ?? "required",
    organizationBrandingMode: options.organizationBrandingMode,
    projectGoalSetMode: options.projectGoalSetMode,
    binaryPath: fixture.binaryPath,
    actorEnvelopeKey: "bridge-test-secret",
    requestTimeoutMs: 25,
  });
  activeBridges.add(bridge);
  return bridge;
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
    const defaultDebugBinary = fileURLToPath(new URL("../../../native/target/debug/rudder-server-foundation", import.meta.url));
    expect(existsSync(defaultDebugBinary)).toBe(true);
    const root = await mkdtemp(join(tmpdir(), "rudder-rust-foundation-explicit-path-"));
    const previousPath = process.env.RUDDER_SERVER_FOUNDATION_PATH;
    process.env.RUDDER_SERVER_FOUNDATION_PATH = join(root, "rudder-server-foundation-missing");

    try {
      const bridge = createRustFoundationBridge({
        databaseUrl: "postgres://bridge-test",
        mode: "required",
        actorEnvelopeKey: "bridge-test-secret",
      });
      activeBridges.add(bridge);

      await expect(bridge.start()).rejects.toMatchObject({ code: "binary_unavailable" });
    } finally {
      if (previousPath === undefined) delete process.env.RUDDER_SERVER_FOUNDATION_PATH;
      else process.env.RUDDER_SERVER_FOUNDATION_PATH = previousPath;
      await rm(root, { recursive: true, force: true });
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
});
