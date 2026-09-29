import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run only after the parent releases the serialized local PostgreSQL slot:
// node cli/node_modules/tsx/dist/cli.mjs scripts/smoke/rust-project-create-real-entry.ts
// This is author smoke evidence, not independent acceptance.
type Json = Record<string, any>;
type Reply = { status: number; body: Json };
type ServerHandle = Awaited<ReturnType<typeof import("../../server/src/index.js").startServer>>;

// CLI UUID parsers accept versions 1-5; Planck chose UUIDv5 over the proposed UUIDv8.
export function assertCliCompatibleProjectId(projectId: unknown): asserts projectId is string {
  if (typeof projectId !== "string") throw new TypeError("Project ID must be a UUID string");
  assert.match(
    projectId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
}

export function ownedFoundationPids(processListing: string, parentPid: number, binaryPath: string): number[] {
  return processListing.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    return match && Number(match[2]) === parentPid
      && (match[3] === binaryPath || match[3].startsWith(binaryPath + " "))
      ? [Number(match[1])] : [];
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function readResponse(response: Response): Promise<Reply> {
  const text = await response.text();
  let body: Json;
  try {
    body = JSON.parse(text) as Json;
  } catch {
    body = { text };
  }
  return { status: response.status, body };
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Owned foundation child " + pid + " did not exit");
}

async function runChildProcess(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      signal: AbortSignal.timeout(30_000),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
  });
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const requireFromDb = createRequire(path.join(repoRoot, "packages/db/package.json"));
  const postgresModule = requireFromDb("postgres") as {
    default?: (...args: any[]) => any;
  } | ((...args: any[]) => any);
  const postgres = ("default" in postgresModule ? postgresModule.default : postgresModule) as (...args: any[]) => any;
  const { drizzle } = requireFromDb("drizzle-orm/postgres-js");
  const home = await mkdtemp(path.join(os.tmpdir(), "rudder-rust-project-create-"));
  const originalEnv = { ...process.env };
  const binaryPath = path.join(home, "rudder-server-foundation");
  const apiPort = await availablePort();
  const databasePort = await availablePort();
  let current: ServerHandle | null = null;
  let sql: any = null;

  try {
    await copyFile(
      originalEnv.RUDDER_SERVER_FOUNDATION_PATH
        ?? path.join(repoRoot, "native/target/debug/rudder-server-foundation"),
      binaryPath,
    );
    await chmod(binaryPath, 0o755);
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("RUDDER_")) delete process.env[key];
    }
    Object.assign(process.env, {
      DATABASE_URL: "",
      RUDDER_HOME: home,
      RUDDER_INSTANCE_ID: "project-create-real-entry-" + process.pid,
      RUDDER_AGENT_JWT_SECRET: randomUUID(),
      RUDDER_EMBEDDED_POSTGRES_PORT: String(databasePort),
      RUDDER_MIGRATION_AUTO_APPLY: "true",
      RUDDER_MIGRATION_PROMPT: "never",
      RUDDER_NATIVE_MODE: "required",
      RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH: originalEnv.RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH
        ?? path.join(repoRoot, "native/target/debug/migration-preflight"),
      RUDDER_SERVER_FOUNDATION_PATH: binaryPath,
      RUDDER_NATIVE_ACTOR_ENVELOPE_KEY: randomUUID(),
      RUDDER_DEPLOYMENT_MODE: "local_trusted",
      RUDDER_RUST_MEMBER_DIRECTORY_MODE: "off",
      RUDDER_RUST_ORGANIZATION_BRANDING_MODE: "off",
      RUDDER_RUST_PROJECT_GOAL_SET_MODE: "required",
      RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS: "",
      RUDDER_OPEN_ON_LISTEN: "false",
    });

    const { startServer } = await import("../../server/src/index.js");
    const stop = async () => {
      await sql?.end({ timeout: 2 });
      sql = null;
      if (current) {
        await current.stop();
        await current.dispose();
        current = null;
      }
    };
    const start = async () => {
      current = await startServer({
        runtimeOwnerKind: "server",
        openOnListen: false,
        printBanner: false,
        runtimeOverrides: {
          host: "127.0.0.1",
          port: apiPort,
          serveUi: false,
          uiDevMiddleware: false,
          heartbeatSchedulerEnabled: false,
          databaseBackupEnabled: false,
        },
      });
      sql = postgres(current.databaseUrl, { max: 2, onnotice: () => {} });
    };
    await start();

    const request = async (
      url: string,
      method = "GET",
      body?: Json,
      headers: Record<string, string> = {},
    ): Promise<Reply> => {
      return await readResponse(await fetch(current!.apiUrl + "/api" + url, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      }));
    };
    const create = async (url: string, body: Json, headers: Record<string, string> = {}) => {
      const response = await request(url, "POST", body, headers);
      assert.equal(response.status, 201, JSON.stringify(response.body));
      return response.body;
    };

    const organization = await create("/orgs", {
      name: "Rust Project-create author smoke",
      issuePrefix: "RPCS",
      requireBoardApprovalForNewAgents: false,
    });
    assert.match(String(organization.id), /^[0-9a-f-]{36}$/u);

    const idempotencyKey = "project-create-author-" + randomUUID();
    const projectInput = { name: "Rust Project-create author smoke project" };
    const created = await create(
      "/orgs/" + organization.id + "/projects",
      projectInput,
      { "x-rudder-idempotency-key": idempotencyKey },
    );
    assertCliCompatibleProjectId(created.id);
    assert.equal(created.orgId, organization.id);
    assert.equal(created.name, projectInput.name);

    const ownerRows = await sql.unsafe(
      "SELECT owner FROM project_goal_mutation_state WHERE org_id = $1 AND project_id = $2",
      [organization.id, created.id],
    );
    assert.deepEqual(Array.from(ownerRows), [{ owner: "rust" }], "new Project did not persist Rust ownership");

    const { resolveProjectLibraryDir } = await import("../../server/src/home-paths.js");
    const libraryRoot = resolveProjectLibraryDir({
      orgId: organization.id,
      projectId: created.id,
      projectName: created.name,
      projectUrlKey: created.urlKey,
    });
    const readme = await readFile(path.join(libraryRoot, "README.md"), "utf8");
    const expectedReadme = [
      "# " + created.name,
      "",
      "Agents should keep durable project work files inside this folder.",
      "Attached Project Resources are surfaced in the Library tree under \u0060resources/\u0060 as virtual references; external resources are not copied into this folder.",
      "",
    ].join("\n");
    assert.equal(readme, expectedReadme, "Library README was not ready with Node-compatible content at create success");

    const replay = await request(
      "/orgs/" + organization.id + "/projects",
      "POST",
      projectInput,
      { "x-rudder-idempotency-key": idempotencyKey },
    );
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, created, "same-key create replay changed the original response");

    if (process.argv.includes("--basic-only")) {
      console.log(JSON.stringify({
        marker: "RUST_PROJECT_CREATE_BASIC_AUTHOR_SMOKE",
        organizationId: organization.id,
        projectId: created.id,
        persistedOwner: "rust",
        libraryReadme: "node-compatible-and-ready",
        keyedReplay: "exact",
      }));
      return;
    }

    await stop();
    await start();
    const replayAfterRestart = await request(
      "/orgs/" + organization.id + "/projects",
      "POST",
      projectInput,
      { "x-rudder-idempotency-key": idempotencyKey },
    );
    assert.equal(replayAfterRestart.status, 201, JSON.stringify(replayAfterRestart.body));
    assert.deepEqual(replayAfterRestart.body, created, "restart replay changed the original response");
    const ownerAfterRestart = await sql.unsafe(
      "SELECT owner FROM project_goal_mutation_state WHERE org_id = $1 AND project_id = $2",
      [organization.id, created.id],
    );
    assert.deepEqual(Array.from(ownerAfterRestart), [{ owner: "rust" }], "Rust ownership did not survive restart");

    const mutation = await request(
      "/projects/" + created.id,
      "PATCH",
      { description: "updated through persisted Rust ownership after restart" },
      { "x-rudder-idempotency-key": "project-create-patch-" + randomUUID() },
    );
    assert.equal(mutation.status, 200, JSON.stringify(mutation.body));
    assert.equal(mutation.body.description, "updated through persisted Rust ownership after restart");

    const agent = await create("/orgs/" + organization.id + "/agents", {
      name: "Project-create CLI smoke agent",
      role: "engineer",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
    });
    const agentKey = await create("/agents/" + agent.id + "/keys", { name: "Project-create CLI smoke key" });
    assert.match(String(agentKey.token), /^pcp_[a-f0-9]{48}$/u);
    const cliName = "Rust Project-create CLI smoke project";
    const cliResult = await runChildProcess(
      process.execPath,
      [
        path.join(repoRoot, "cli/node_modules/tsx/dist/cli.mjs"),
        "cli/src/index.ts",
        "project",
        "create",
        "--org-id",
        organization.id,
        "--name",
        cliName,
        "--description",
        "Created through the actual CLI process",
        "--api-base",
        current.apiUrl,
        "--data-dir",
        path.join(home, "cli-data"),
        "--full-ids",
        "--json",
      ],
      repoRoot,
      {
        ...process.env,
        RUDDER_API_URL: current.apiUrl,
        RUDDER_API_KEY: agentKey.token,
        RUDDER_ORG_ID: organization.id,
        RUDDER_AGENT_ID: agent.id,
      },
    );
    assert.equal(cliResult.exitCode, 0, cliResult.stderr || cliResult.stdout);
    const cliProject = JSON.parse(cliResult.stdout.trim()) as Json;
    assertCliCompatibleProjectId(cliProject.id);
    assert.equal(cliProject.orgId, organization.id);
    assert.equal(cliProject.name, cliName);
    const cliOwner = await sql.unsafe(
      "SELECT owner FROM project_goal_mutation_state WHERE org_id = $1 AND project_id = $2",
      [organization.id, cliProject.id],
    );
    assert.deepEqual(Array.from(cliOwner), [{ owner: "rust" }], "CLI-created Project did not persist Rust ownership");

    const mcpName = "Rust Project-create MCP smoke project";
    const mcpInput = [
      JSON.stringify({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "rust-project-create-real-entry", version: "1" },
        },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: "project-create",
        method: "tools/call",
        params: {
          name: "rudder_project_create",
          arguments: { name: mcpName, description: "Created through MCP stdio" },
        },
      }),
      "",
    ].join("\n");
    const mcpResult = await runChildProcess(
      process.execPath,
      [
        path.join(repoRoot, "cli/node_modules/tsx/dist/cli.mjs"),
        "cli/src/index.ts",
        "mcp-server",
        "--server",
        "core",
      ],
      repoRoot,
      {
        ...process.env,
        RUDDER_API_URL: current.apiUrl,
        RUDDER_API_KEY: agentKey.token,
        RUDDER_ORG_ID: organization.id,
        RUDDER_AGENT_ID: agent.id,
      },
      mcpInput,
    );
    assert.equal(mcpResult.exitCode, 0, mcpResult.stderr || mcpResult.stdout);
    const mcpMessages = mcpResult.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Json);
    const mcpCall = mcpMessages.find((message) => message.id === "project-create");
    assert.ok(mcpCall, "MCP stdio server did not return the Project-create tool result");
    const mcpToolResult = mcpCall.result as Json;
    assert.equal(mcpToolResult.isError, false, JSON.stringify(mcpToolResult));
    const mcpProject = mcpToolResult.structuredContent as Json;
    assertCliCompatibleProjectId(mcpProject.id);
    assert.equal(mcpProject.orgId, organization.id);
    assert.equal(mcpProject.name, mcpName);
    const mcpOwner = await sql.unsafe(
      "SELECT owner FROM project_goal_mutation_state WHERE org_id = $1 AND project_id = $2",
      [organization.id, mcpProject.id],
    );
    assert.deepEqual(Array.from(mcpOwner), [{ owner: "rust" }], "MCP-created Project did not persist Rust ownership");

    const foreignOrganization = await create("/orgs", {
      name: "Rust Project-create foreign scope",
      issuePrefix: "RPCF",
      requireBoardApprovalForNewAgents: false,
    });
    const scopedHeaders = {
      authorization: "Bearer " + agentKey.token,
      "x-rudder-agent-id": agent.id,
    };
    const foreignDenied = await request(
      "/orgs/" + foreignOrganization.id + "/projects",
      "POST",
      { name: "Must not cross organization scope" },
      scopedHeaders,
    );
    assert.equal(foreignDenied.status, 403, JSON.stringify(foreignDenied.body));
    await sql.unsafe("UPDATE agents SET status = 'terminated' WHERE id = $1", [agent.id]);
    const terminatedDenied = await request(
      "/orgs/" + organization.id + "/projects",
      "POST",
      { name: "Must not be created by a terminated actor" },
      scopedHeaders,
    );
    assert.equal(terminatedDenied.status, 401, JSON.stringify(terminatedDenied.body));
    const deniedProjectCount = await sql.unsafe(
      "SELECT count(*)::int AS count FROM projects WHERE org_id = $1 AND name IN ($2, $3)",
      [foreignOrganization.id, "Must not cross organization scope", "Must not be created by a terminated actor"],
    );
    assert.deepEqual(Array.from(deniedProjectCount), [{ count: 0 }], "denied actor created a Project");

    const outageName = "Project-create must fail closed during Rust outage";
    const countBeforeOutage = await sql.unsafe(
      "SELECT count(*)::int AS count FROM projects WHERE org_id = $1",
      [organization.id],
    );
    const processArgs = process.platform === "darwin"
      ? ["-axo", "pid=,ppid=,command="]
      : ["-eo", "pid=,ppid=,args="];
    const processListing = execFileSync("ps", processArgs, { encoding: "utf8" });
    const foundationChildren = ownedFoundationPids(processListing, process.pid, binaryPath);
    assert.equal(foundationChildren.length, 1, "expected one native child launched from this smoke's private binary copy");
    await rename(binaryPath, binaryPath + ".disabled");
    process.kill(foundationChildren[0]!, "SIGKILL");
    await waitForExit(foundationChildren[0]!);
    const outageResponse = await request(
      "/orgs/" + organization.id + "/projects",
      "POST",
      { name: outageName },
      { "x-rudder-idempotency-key": "project-create-outage-" + randomUUID() },
    );
    assert.equal(outageResponse.status, 503, JSON.stringify(outageResponse.body));
    assert.equal((await request("/health")).status, 200, "API did not remain available during Rust outage");
    const countAfterOutage = await sql.unsafe(
      "SELECT count(*)::int AS count FROM projects WHERE org_id = $1",
      [organization.id],
    );
    assert.deepEqual(Array.from(countAfterOutage), Array.from(countBeforeOutage), "Rust outage fell back to a Node Project write");

    console.log(JSON.stringify({
      marker: "RUST_PROJECT_CREATE_AUTHOR_SMOKE",
      organizationId: organization.id,
      projectId: created.id,
      persistedOwner: "rust",
      libraryReadme: "node-compatible-and-ready",
      keyedReplay: "exact",
      replayAfterRestart: "exact",
      subsequentMutation: "persisted-owner-routed",
      cliProjectId: cliProject.id,
      mcpProjectId: mcpProject.id,
      crossOrganizationDenied: foreignDenied.status,
      terminatedActorDenied: terminatedDenied.status,
      rustOutageCreateStatus: outageResponse.status,
      outageNodeFallback: false,
    }));
  } finally {
    const cleanupErrors: unknown[] = [];
    try { await sql?.end({ timeout: 2 }); } catch (error) { cleanupErrors.push(error); }
    if (current) {
      try { await current.stop(); } catch (error) { cleanupErrors.push(error); }
      try { await current.dispose(); } catch (error) { cleanupErrors.push(error); }
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, "Smoke cleanup failed; disposable data retained at " + home);
    }
    await rm(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
