import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const APP_ID = "44444444-4444-4444-8444-444444444444";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../resources/bundled-skills/app-builder/scripts/report-build-status.mjs",
);

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function runScript(input: {
  currentStatus: string;
  reportStatus: string;
}) {
  let patchBody: Record<string, unknown> | null = null;
  const server = http.createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{
        id: APP_ID,
        buildStatus: input.currentStatus,
        latestBuildRunId: RUN_ID,
        latestVerificationRunId: null,
      }]));
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      patchBody = JSON.parse(body) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ buildStatus: patchBody.status }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing mock server port");

  const child = spawn(process.execPath, [SCRIPT_PATH, input.reportStatus, APP_ID], {
    env: {
      ...process.env,
      RUDDER_API_URL: `http://127.0.0.1:${address.port}`,
      RUDDER_API_KEY: "run-secret",
      RUDDER_ORG_ID: ORG_ID,
      RUDDER_RUN_ID: RUN_ID,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { exitCode, patchBody, stderr, stdout };
}

describe("App Builder status script", () => {
  it("reports verified source with a compare-and-set transition", async () => {
    const result = await runScript({
      currentStatus: "building",
      reportStatus: "verified_source_ready",
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stderr: "",
      patchBody: {
        status: "verified_source_ready",
        expectedStatus: "building",
        runId: RUN_ID,
        runKind: "verification",
      },
    });
    expect(result.stdout).toContain("App Builder status: verified_source_ready");
  });

  it("rejects a stale verified-source report without patching state", async () => {
    const result = await runScript({
      currentStatus: "ready",
      reportStatus: "verified_source_ready",
    });
    expect(result.exitCode).toBe(1);
    expect(result.patchBody).toBeNull();
    expect(result.stderr).toContain("stale App handoff transition ready -> verified_source_ready");
  });
});
