import { resolveOpenCodeProfileDataHome } from "@rudderhq/agent-runtime-opencode-local/server";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const EXPECTED_OPENCODE_SHA256 = "fe28e57fd7c7e5d133e66ee906c519d2b1c3b263c59165123be91d680b105c9a";
const binary = process.env.RUDDER_OPENCODE_NOREPLY_BINARY;

describe("OpenCode isolated noReply storage fixture", { timeout: 30_000 }, () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = null;
  });

  it.skipIf(!binary)("persists a user-only 1.15.11 noReply turn under the isolated profile data root", async () => {
    const executable = binary!;
    const digest = createHash("sha256").update(await fs.readFile(executable)).digest("hex");
    expect(digest).toBe(EXPECTED_OPENCODE_SHA256);

    root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-noreply-profile-"));
    const operatorHome = path.join(root, "operator-home");
    const configHome = path.join(root, "xdg-config");
    const cacheHome = path.join(root, "xdg-cache");
    const stateHome = path.join(root, "xdg-state");
    const cwd = path.join(root, "cwd");
    const rudderHome = path.join(root, "rudder");
    const legacyDb = path.join(operatorHome, ".local", "share", "opencode", "opencode.db");
    const profileDataHome = resolveOpenCodeProfileDataHome({
      env: { RUDDER_HOME: rudderHome, RUDDER_INSTANCE_ID: "noreply-fixture" },
      providerHostId: "local",
      providerProfileId: "diagnostic",
    }, "org-noreply-fixture");
    await Promise.all([
      operatorHome,
      configHome,
      cacheHome,
      stateHome,
      cwd,
      path.dirname(legacyDb),
    ].map((directory) => fs.mkdir(directory, { recursive: true })));
    await fs.writeFile(legacyDb, "preserve-legacy-global-db", { mode: 0o600 });

    let modelRequests = 0;
    const modelTripwire = http.createServer((_request, response) => {
      modelRequests += 1;
      response.writeHead(503);
      response.end("model calls disabled");
    });
    await new Promise<void>((resolve) => modelTripwire.listen(0, "127.0.0.1", resolve));
    const modelAddress = modelTripwire.address();
    if (!modelAddress || typeof modelAddress === "string") throw new Error("Model tripwire did not bind a TCP port");

    const reservation = http.createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const serverAddress = reservation.address();
    if (!serverAddress || typeof serverAddress === "string") throw new Error("OpenCode port reservation failed");
    const port = serverAddress.port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));

    const logFd = await fs.open(path.join(root, "native.log"), "w", 0o600);
    const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: operatorHome,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: profileDataHome,
        XDG_CACHE_HOME: cacheHome,
        XDG_STATE_HOME: stateHome,
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        OPENCODE_DISABLE_CLAUDE_CODE: "true",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          plugin: [],
          provider: {
            diagnostic: {
              npm: "@ai-sdk/openai-compatible",
              name: "Local noReply tripwire",
              options: { baseURL: `http://127.0.0.1:${modelAddress.port}/v1` },
              models: { synthetic: { name: "Synthetic" } },
            },
          },
        }),
      },
      stdio: ["ignore", logFd.fd, logFd.fd],
    });
    const serverUrl = `http://127.0.0.1:${port}`;
    const request = async (route: string, body?: unknown) => {
      const response = await fetch(`${serverUrl}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(2_500),
      });
      const text = await response.text();
      return { status: response.status, value: text ? JSON.parse(text) as Record<string, unknown> : null };
    };

    try {
      const startupDeadline = Date.now() + 20_000;
      let healthy = false;
      while (Date.now() < startupDeadline && child.exitCode === null) {
        try {
          const health = await request("/global/health");
          if (health.status === 200 && health.value?.version === "1.15.11") {
            healthy = true;
            break;
          }
        } catch {
          // The local server is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      expect(healthy).toBe(true);

      const directory = encodeURIComponent(cwd);
      const created = await request(`/session?directory=${directory}`, {});
      expect(created.status).toBe(200);
      const sessionId = created.value?.id;
      expect(sessionId).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]+$/u));
      const submitted = await request(`/session/${sessionId}/prompt_async?directory=${directory}`, {
        messageID: "msg_profile_isolation_noreply",
        parts: [{ type: "text", text: "Synthetic local persistence check; no assistant response." }],
        model: { providerID: "diagnostic", modelID: "synthetic" },
        noReply: true,
      });
      expect(submitted.status).toBe(204);

      const databasePath = path.join(profileDataHome, "opencode", "opencode.db");
      const rowsDeadline = Date.now() + 10_000;
      let messages: Array<{ id: string; role: string }> = [];
      while (Date.now() < rowsDeadline) {
        const raw = execFileSync("sqlite3", [
          "-readonly",
          "-json",
          databasePath,
          `SELECT id, json_extract(data, '$.role') AS role FROM message WHERE session_id='${sessionId}'`,
        ], { encoding: "utf8" });
        messages = raw.trim() ? JSON.parse(raw) as Array<{ id: string; role: string }> : [];
        if (messages.some((message) => message.id === "msg_profile_isolation_noreply")) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      expect(messages).toContainEqual({ id: "msg_profile_isolation_noreply", role: "user" });
      expect(messages.some((message) => message.role === "assistant")).toBe(false);
      expect(modelRequests).toBe(0);
      expect(await fs.readFile(legacyDb, "utf8")).toBe("preserve-legacy-global-db");
      expect(await fs.realpath(databasePath)).toContain(`${await fs.realpath(profileDataHome)}${path.sep}`);
      expect(await fs.realpath(databasePath)).not.toContain(`${await fs.realpath(operatorHome)}${path.sep}`);
    } finally {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
      modelTripwire.closeAllConnections();
      await new Promise<void>((resolve) => modelTripwire.close(() => resolve()));
      await logFd.close();
    }
  });
});
