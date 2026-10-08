import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRustActorEnvelope, createRustFoundationBridge, type RustFoundationBridge } from "./rust-foundation-bridge.js";

const resources: Array<{ root: string; bridge: RustFoundationBridge }> = [];

afterEach(async () => {
  for (const { root, bridge } of resources.splice(0)) {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rudder-run-read-bridge-"));
  const binaryPath = join(root, "foundation.cjs");
  const capturedPath = join(root, "captured.jsonl");
  await writeFile(binaryPath, `#!${process.execPath}
const fs = require('node:fs');
const http = require('node:http');
const server = http.createServer((req, res) => {
  if (req.url === '/readyz') { res.end('ready'); return; }
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    fs.appendFileSync(${JSON.stringify(capturedPath)}, JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }) + '\\n');
    res.setHeader('content-type', 'application/json');
    res.statusCode = 200;
    res.end('[{"id":"legacy-run","resultJson":null,"startedAt":null}]');
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ boundAddr: '127.0.0.1:' + server.address().port, publicListener: false, productWriteAuthority: false }) + '\\n'));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
`, "utf8");
  await chmod(binaryPath, 0o755);
  const bridge = createRustFoundationBridge({
    databaseUrl: "postgres://synthetic-unused",
    binaryPath,
    mode: "off",
    projectGoalSetMode: "off",
    organizationBrandingMode: "off",
    actorEnvelopeKey: "synthetic-run-read-bridge-key",
  });
  resources.push({ root, bridge });
  return {
    bridge,
    async requests(): Promise<Array<{ method: string; url: string; headers: Record<string, string>; body: string }>> {
      return (await readFile(capturedPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    },
  };
}

describe("run-read native read transport", () => {
  it("requires native startup even when optional authorities are off", async () => {
    const { bridge } = await fixture();
    expect(bridge.requiresStartup).toBe(true);
  });

  it("binds the complete selection and actor to the private read path", async () => {
    const { bridge, requests } = await fixture();
    const actor = { type: "board", source: "local_implicit", userId: "board-test" } as const;
    const input = { operation: "list", surface: "agent", agentId: null, goalId: "20000000-0000-4000-8000-000000000001", startDate: null, endDate: null, limit: 20 } as const;
    const response = await bridge.runRead!(actor, "org-1", input);
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe('[{"id":"legacy-run","resultJson":null,"startedAt":null}]');
    const [captured] = await requests();
    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("/internal/orgs/org-1/run-reads");
    expect(JSON.parse(captured.body)).toEqual(input);
    const envelope = JSON.parse(captured.headers["x-rudder-actor-envelope"]);
    expect(envelope.action).toBe("run.read");
    expect(envelope.bodySha256).toBe(createHash("sha256").update(captured.body).digest("hex"));
    expect(envelope.requestId).toBe(captured.headers["x-rudder-request-id"]);
    expect(envelope).toEqual(createRustActorEnvelope({
      actor,
      organizationId: "org-1",
      method: "POST",
      path: captured.url,
      action: "run.read",
      body: Buffer.from(captured.body),
      secret: "synthetic-run-read-bridge-key",
      nowSeconds: envelope.expiresAt - 60,
      requestId: envelope.requestId,
      nonce: envelope.nonce,
    }));
  });

  it("keeps concurrent read bodies and nonces isolated", async () => {
    const { bridge, requests } = await fixture();
    const actor = { type: "agent", source: "agent_key", agentId: "agent-1", orgId: "org-1" } as const;
    const inputs = Array.from({ length: 12 }, (_, index) => ({ operation: "active" as const, issueId: `issue-${index}`, redaction: { userNames: [], homeDirs: [], replacement: "*" } }));
    const responses = await Promise.all(inputs.map(input => bridge.runRead!(actor, "org-1", input)));
    expect(responses.every(response => response.status === 200)).toBe(true);
    const captured = await requests();
    expect(captured.map(value => JSON.parse(value.body).issueId).sort()).toEqual(inputs.map(value => value.issueId).sort());
    const envelopes = captured.map(value => JSON.parse(value.headers["x-rudder-actor-envelope"]));
    expect(new Set(envelopes.map(value => value.nonce)).size).toBe(inputs.length);
    expect(new Set(envelopes.map(value => value.requestId)).size).toBe(inputs.length);
    expect(envelopes.every(value => value.actor.kind === "agent" && value.actor.id === "agent-1")).toBe(true);
  });
});
