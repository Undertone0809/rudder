import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createOpenCodeLocalProviderCapabilities,
  disposeOpenCodeNativeServersForTests,
  type OpenCodeBinding,
  type OpenCodeSession,
} from "./index.js";

const tempDirectories: string[] = [];

type FixtureOptions = {
  parentId?: string;
  children?: unknown[];
  attestDelete?: boolean;
};

type FixtureRequest = { method: string; path: string; authorized: boolean };

async function makeFixture(options: FixtureOptions = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-cleanup-"));
  tempDirectories.push(cwd);
  const command = path.join(cwd, "opencode-cleanup-fixture.mjs");
  const contract = options.attestDelete === false
    ? "Delete a session."
    : "Delete a session and permanently remove all associated data, including messages and history.";
  const document = {
    paths: {
      "/session/{sessionID}": {
        get: { operationId: "session.get" },
        delete: {
          operationId: "session.delete",
          description: contract,
          responses: { "200": { content: { "application/json": { schema: { type: "boolean" } } } } },
        },
      },
      "/session/{sessionID}/children": {
        get: {
          operationId: "session.children",
          description: "Retrieve all child sessions that were forked from the specified parent session.",
        },
      },
    },
  };
  await fs.writeFile(command, `#!/usr/bin/env node
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const options = ${JSON.stringify({ parentId: options.parentId ?? "parent-session", children: options.children ?? [] })};
const document = ${JSON.stringify(document)};
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  fs.appendFileSync(path.join(process.cwd(), "cleanup-requests.jsonl"), JSON.stringify({
    method: request.method,
    path: url.pathname,
    authorized: Boolean(request.headers.authorization),
  }) + "\\n");
  response.setHeader("content-type", "application/json");
  if (url.pathname === "/global/health") return response.end(JSON.stringify({ version: "1.2.3" }));
  if (url.pathname === "/doc") return response.end(JSON.stringify(document));
  if (url.pathname === "/session/fork-session" && request.method === "GET") {
    return response.end(JSON.stringify({ id: "fork-session", parentID: options.parentId }));
  }
  if (url.pathname === "/session/fork-session/children" && request.method === "GET") {
    return response.end(JSON.stringify(options.children));
  }
  if (url.pathname === "/session/fork-session" && request.method === "DELETE") {
    return response.end(JSON.stringify(true));
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ message: "missing fixture route" }));
});
server.listen(port, "127.0.0.1", () => process.stdout.write("http://127.0.0.1:" + port + "\\n"));
`, { encoding: "utf8", mode: 0o700 });
  await fs.chmod(command, 0o700);

  const binding: OpenCodeBinding = {
    id: "profile-binding-1",
    orgId: "org-1",
    hostId: "local",
    profileId: "opencode-profile",
    workspaceBindingId: "workspace-binding-1",
    capabilityRevision: "capability-revision-1",
  };
  const session: OpenCodeSession = {
    sessionId: "fork-session",
    sessionDisplayId: "fork-session",
    sessionParams: {
      sessionId: "fork-session",
      hostId: binding.hostId,
      profileId: binding.profileId,
      profileBindingId: binding.id,
      profileOrgId: binding.orgId,
      workspaceBindingId: binding.workspaceBindingId,
      capabilityRevision: binding.capabilityRevision,
      transport: "opencode-managed-server-http",
      serverUrl: "http://127.0.0.1:9",
      cwd,
      serverCommand: command,
      exportCommand: command,
      exportEnv: { HOME: cwd },
      providerVersion: "1.2.3",
    },
  };
  const adapter = createOpenCodeLocalProviderCapabilities({
    binding,
    providerVersion: "1.2.3",
    command,
    cwd,
  });
  return { cwd, binding, session, adapter };
}

async function requestsFor(cwd: string): Promise<FixtureRequest[]> {
  const content = await fs.readFile(path.join(cwd, "cleanup-requests.jsonl"), "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as FixtureRequest);
}

async function cleanup(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  await fixture.adapter.sideChatForkCleanup.deleteForkedSession({
    runtimeType: "opencode_local",
    session: fixture.session,
    expectedParentSessionId: "parent-session",
    binding: fixture.binding,
  });
}

afterEach(async () => {
  await disposeOpenCodeNativeServersForTests();
  while (tempDirectories.length > 0) {
    await fs.rm(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("OpenCode profile-bound Side Chat cleanup HTTP flow", () => {
  it("deletes only after the profile API attests delete and the exact fork has no descendants", async () => {
    const fixture = await makeFixture();
    await cleanup(fixture);

    const requests = await requestsFor(fixture.cwd);
    expect(requests.every((request) => request.authorized)).toBe(true);
    expect(requests.filter((request) => request.path !== "/global/health").map(({ method, path }) => [method, path])).toEqual([
      ["GET", "/doc"],
      ["GET", "/session/fork-session"],
      ["GET", "/session/fork-session/children"],
      ["DELETE", "/session/fork-session"],
    ]);
  });

  it("retains a fork with provider-side descendants", async () => {
    const fixture = await makeFixture({ children: [{ id: "grandchild-session" }] });
    await expect(cleanup(fixture)).rejects.toThrow("provider-side descendants");

    const requests = await requestsFor(fixture.cwd);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("retains a session whose Provider parent differs from the recorded fork parent", async () => {
    const fixture = await makeFixture({ parentId: "different-parent" });
    await expect(cleanup(fixture)).rejects.toThrow("expected parent");

    const requests = await requestsFor(fixture.cwd);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("does not inspect or delete sessions unless the running profile attests the delete contract", async () => {
    const fixture = await makeFixture({ attestDelete: false });
    await expect(cleanup(fixture)).rejects.toThrow("does not attest the exact session.delete contract");

    const requests = await requestsFor(fixture.cwd);
    expect(requests.map((request) => request.path).filter((requestPath) => requestPath !== "/global/health")).toEqual(["/doc"]);
  });
});
