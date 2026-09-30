import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildYamlFile } from "../../server/src/services/knowledge-portability/organization-portability.package.js";

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

export function projectImportMutationKey(
  importKey: string,
  orgId: string,
  projectId: string,
  phase: "replace" | "hydrate",
): string {
  return createHash("sha256")
    .update(JSON.stringify(["portability-project-update", importKey, orgId, projectId, phase]))
    .digest("hex");
}

export function isOrganizationImportHydrationResponse(
  requestPath: string,
  requestBody: string,
): boolean {
  if (!/^\/api\/orgs\/[^/]+\/projects\/[^/]+\/goal-set$/u.test(requestPath)) return false;
  try {
    const payload = JSON.parse(requestBody) as Json;
    const workspaceId = payload.projectPatch?.executionWorkspacePolicy?.defaultProjectWorkspaceId;
    return payload.mutationOrigin === "organization_import"
      && typeof workspaceId === "string"
      && workspaceId.length > 0;
  } catch {
    return false;
  }
}

export function buildExistingOrganizationProjectImport(input: {
  targetOrgId: string;
  projectSlug: string;
  projectName: string;
  description: string;
  workspaceRepoUrl: string;
}): Json {
  const { targetOrgId, projectSlug, projectName, description, workspaceRepoUrl } = input;
  const extension = {
    schema: "rudder/v1",
    projects: {
      [projectSlug]: {
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceKey: "primary",
        },
        workspaces: {
          primary: {
            name: "Imported primary workspace",
            sourceType: "git_repo",
            repoUrl: workspaceRepoUrl,
            repoRef: "main",
            defaultRef: "main",
            visibility: "default",
            setupCommand: null,
            cleanupCommand: null,
            metadata: { source: "project-create-real-entry" },
            isPrimary: true,
          },
        },
      },
    },
  };
  return {
    source: {
      type: "inline",
      files: {
      "ORGANIZATION.md": "---\nname: Rust Project-create import source\n---\n",
        [`projects/${projectSlug}/PROJECT.md`]: [
          "---",
          "kind: project",
          `name: ${projectName}`,
          `slug: ${projectSlug}`,
          `description: ${description}`,
          "---",
          "Imported through the public organization portability API.",
          "",
        ].join("\n"),
      ".rudder.yaml": buildYamlFile(extension, { preserveEmptyStrings: true }),
      },
    },
    include: { organization: false, agents: false, projects: true, issues: false, skills: false },
    target: { mode: "existing_organization", orgId: targetOrgId },
    collisionStrategy: "replace",
  };
}

function foundationResponseProxySource(
  nativeBinaryPath: string,
  lostResponseMarkerPath: string,
  nativePidMarkerPath: string,
  requestTracePath: string,
): string {
  return [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const http = require("node:http");',
    'const { spawn } = require("node:child_process");',
    'const { createInterface } = require("node:readline");',
    `const isOrganizationImportHydrationResponse = ${isOrganizationImportHydrationResponse.toString()};`,
    `const native = spawn(${JSON.stringify(nativeBinaryPath)}, [], { stdio: ["ignore", "pipe", "inherit"], env: process.env });`,
    `native.once("spawn", () => fs.writeFileSync(${JSON.stringify(nativePidMarkerPath)}, String(native.pid)));`,
    "let proxy = null;",
    "let droppedHydrationResponse = false;",
    "let shuttingDown = false;",
    "const lines = createInterface({ input: native.stdout });",
    "lines.once(\"line\", (line) => {",
    "  let startup;",
    "  try { startup = JSON.parse(line); } catch (error) { console.error(error); process.exit(1); return; }",
    "  const upstream = new URL(\"http://\" + startup.boundAddr);",
    "  proxy = http.createServer((request, response) => {",
    "    const requestChunks = [];",
    "    request.on(\"data\", (chunk) => requestChunks.push(Buffer.from(chunk)));",
    "    request.once(\"error\", () => response.destroy());",
    "    request.once(\"end\", () => {",
    "      const body = Buffer.concat(requestChunks);",
    "      const forwarded = http.request({",
    "        hostname: upstream.hostname,",
    "        port: upstream.port,",
    "        path: request.url || \"/\",",
    "        method: request.method,",
    "        headers: Object.assign({}, request.headers, { host: upstream.host }),",
    "      }, (upstreamResponse) => {",
    "        const responseChunks = [];",
    "        upstreamResponse.on(\"data\", (chunk) => responseChunks.push(Buffer.from(chunk)));",
    "        upstreamResponse.once(\"error\", () => response.destroy());",
    "        upstreamResponse.once(\"end\", () => {",
    "          if ((request.url || \"\").endsWith(\"/goal-set\")) {",
    "            let payload = {};",
    "            try { payload = JSON.parse(body.toString(\"utf8\")); } catch {}",
    `            fs.appendFileSync(${JSON.stringify(requestTracePath)}, JSON.stringify({ method: request.method, path: request.url, status: upstreamResponse.statusCode, mutationOrigin: payload.mutationOrigin || null, hasWorkspaceId: typeof payload.projectPatch?.executionWorkspacePolicy?.defaultProjectWorkspaceId === "string" }) + "\\n");`,
    "          }",
    "          if (!droppedHydrationResponse && upstreamResponse.statusCode >= 200 && upstreamResponse.statusCode < 300",
    "            && isOrganizationImportHydrationResponse(request.url || \"/\", body.toString(\"utf8\"))) {",
    "            droppedHydrationResponse = true;",
    `            fs.writeFileSync(${JSON.stringify(lostResponseMarkerPath)}, "organization_import_hydration_response_dropped\\n");`,
    "            response.destroy();",
    "            return;",
    "          }",
    "          response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);",
    "          response.end(Buffer.concat(responseChunks));",
    "        });",
    "      });",
    "      forwarded.once(\"error\", () => {",
    "        if (response.destroyed) return;",
    "        response.writeHead(502, { \"content-type\": \"application/json\" });",
    "        response.end(JSON.stringify({ error: \"Rust foundation proxy connection failed\" }));",
    "      });",
    "      forwarded.end(body);",
    "    });",
    "  });",
    "  proxy.once(\"error\", (error) => { console.error(error); process.exit(1); });",
    "  proxy.listen(0, \"127.0.0.1\", () => {",
    "    const address = proxy.address();",
    "    if (!address || typeof address === \"string\") { console.error(\"Rust foundation proxy did not bind\"); process.exit(1); return; }",
    "    process.stdout.write(JSON.stringify(Object.assign({}, startup, { boundAddr: address.address + \":\" + address.port })) + \"\\n\");",
    "  });",
    "});",
    "native.once(\"error\", (error) => { console.error(error); process.exit(1); });",
    "native.once(\"exit\", (code, signal) => {",
    "  if (!shuttingDown) { console.error(\"Rust foundation child exited\", code, signal); process.exitCode = code || 1; }",
    "  if (proxy) proxy.close(() => process.exit(shuttingDown ? 0 : (process.exitCode || 1)));",
    "  else process.exit(shuttingDown ? 0 : (process.exitCode || 1));",
    "});",
    "function shutdown() {",
    "  if (shuttingDown) return;",
    "  shuttingDown = true;",
    "  if (native.exitCode === null) native.kill(\"SIGTERM\");",
    "  const timer = setTimeout(() => {",
    "    if (native.exitCode === null) native.kill(\"SIGKILL\");",
    "    if (proxy) proxy.close(() => process.exit(0)); else process.exit(0);",
    "  }, 2500);",
    "  timer.unref();",
    "}",
    "process.once(\"SIGTERM\", shutdown);",
    "process.once(\"SIGINT\", shutdown);",
  ].join("\n") + "\n";
}

export function ownedFoundationPids(processListing: string, parentPid: number, binaryPath: string): number[] {
  return processListing.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    const commandTokens = match?.[3]?.trim().split(/\s+/u) ?? [];
    const nodeRunsExactScript = path.basename(commandTokens[0] ?? "") === "node"
      && commandTokens[1] === binaryPath;
    return match && Number(match[2]) === parentPid
      && (match[3] === binaryPath || match[3].startsWith(binaryPath + " ") || nodeRunsExactScript)
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
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) throw new Error("Child process output streams were not piped");
    stdoutStream.on("data", (chunk) => { stdout += String(chunk); });
    stderrStream.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    if (input !== undefined) {
      const stdinStream = child.stdin;
      if (!stdinStream) throw new Error("Child process input stream was not piped");
      stdinStream.end(input);
    }
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
  const nativeBinaryPath = path.join(home, "rudder-server-foundation.real");
  const lostHydrationResponseMarker = path.join(home, "organization-import-hydration-response-dropped");
  const nativePidMarker = path.join(home, "rudder-server-foundation.pid");
  const projectGoalRequestTrace = path.join(home, "project-goal-request-trace.jsonl");
  const apiPort = await availablePort();
  const databasePort = await availablePort();
  let current: ServerHandle | null = null;
  let sql: any = null;

  try {
    await copyFile(
      originalEnv.RUDDER_SERVER_FOUNDATION_PATH
        ?? path.join(repoRoot, "native/target/debug/rudder-server-foundation"),
      nativeBinaryPath,
    );
    await chmod(nativeBinaryPath, 0o755);
    await writeFile(
      binaryPath,
      foundationResponseProxySource(nativeBinaryPath, lostHydrationResponseMarker, nativePidMarker, projectGoalRequestTrace),
      "utf8",
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
    const currentServer = (): ServerHandle => {
      const server = current as ServerHandle | null;
      if (!server) throw new Error("Smoke server is not running");
      return server;
    };
    await start();

    const request = async (
      url: string,
      method = "GET",
      body?: Json,
      headers: Record<string, string> = {},
    ): Promise<Reply> => {
      return await readResponse(await fetch(currentServer().apiUrl + "/api" + url, {
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
    const projectInput = {
      name: "Rust Project-create author smoke project",
      newResources: [{
        name: "Project-create shared resource",
        kind: "url",
        sourceType: "external",
        locator: "https://example.com/rudder-project-create-real-entry/shared-resource",
        description: "Created with the public Rust Project request",
        metadata: { fixture: "rust-project-create-real-entry", revision: 1 },
        role: "reference",
        note: "Initial Project attachment metadata",
        sortOrder: 1,
        isPrimary: true,
      }, {
        name: "Project-create Rust outage resource fixture",
        kind: "url",
        sourceType: "external",
        locator: "https://example.com/rudder-project-create-real-entry/outage-resource",
        description: "Remains present for the Rust-unavailable no-fallback assertion",
        metadata: { fixture: "rust-project-create-real-entry", purpose: "native-outage" },
        role: "reference",
        note: "Legacy Node writer must not update this Rust-owned resource during outage",
        sortOrder: 2,
        isPrimary: false,
      }],
    };
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

    const inlineResourceRows = await sql.unsafe(
      "SELECT r.id::text AS id, r.org_id::text AS org_id, r.name, r.kind, r.source_type, r.locator, "
        + "r.description, r.metadata::text AS metadata, a.id::text AS attachment_id, "
        + "a.project_id::text AS project_id, a.role, a.note, a.sort_order, a.is_primary "
        + "FROM organization_resources r JOIN project_resource_attachments a "
        + "ON a.org_id = r.org_id AND a.resource_id = r.id "
        + "WHERE r.org_id = $1 AND a.project_id = $2 AND r.name = $3",
      [organization.id, created.id, projectInput.newResources[0]!.name],
    ) as Json[];
    assert.equal(inlineResourceRows.length, 1, "Rust Project create did not create exactly one inline Organization Resource");
    const inlineResource = inlineResourceRows[0]!;
    const resourceId = String(inlineResource.id);
    assert.match(resourceId, /^[0-9a-f-]{36}$/u);
    assert.equal(inlineResource.org_id, organization.id);
    assert.equal(inlineResource.project_id, created.id);
    assert.deepEqual({
      name: inlineResource.name,
      role: inlineResource.role,
      note: inlineResource.note,
      sortOrder: inlineResource.sort_order,
      isPrimary: inlineResource.is_primary,
    }, {
      name: projectInput.newResources[0]!.name,
      role: projectInput.newResources[0]!.role,
      note: projectInput.newResources[0]!.note,
      sortOrder: projectInput.newResources[0]!.sortOrder,
      isPrimary: projectInput.newResources[0]!.isPrimary,
    });
    const outageResourceRows = await sql.unsafe(
      "SELECT r.id::text AS id, r.org_id::text AS org_id, a.project_id::text AS project_id "
        + "FROM organization_resources r JOIN project_resource_attachments a "
        + "ON a.org_id = r.org_id AND a.resource_id = r.id "
        + "WHERE r.org_id = $1 AND a.project_id = $2 AND r.name = $3",
      [organization.id, created.id, projectInput.newResources[1]!.name],
    ) as Json[];
    assert.equal(outageResourceRows.length, 1, "public Rust create did not persist the outage resource fixture");
    const outageResourceId = String(outageResourceRows[0]!.id);
    assert.match(outageResourceId, /^[0-9a-f-]{36}$/u);
    assert.equal(outageResourceRows[0]!.org_id, organization.id);
    assert.equal(outageResourceRows[0]!.project_id, created.id);

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
        resourceId,
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

    const secondRustProject = await create(
      "/orgs/" + organization.id + "/projects",
      { name: "Rust Project-create second shared-resource project" },
      { "x-rudder-idempotency-key": "resource-second-rust-project-" + randomUUID() },
    );
    assertCliCompatibleProjectId(secondRustProject.id);
    const secondRustOwner = await sql.unsafe(
      "SELECT owner FROM project_goal_mutation_state WHERE org_id = $1 AND project_id = $2",
      [organization.id, secondRustProject.id],
    );
    assert.deepEqual(Array.from(secondRustOwner), [{ owner: "rust" }]);

    // Legacy fixture preparation: preserve a Node-owned Project through the
    // trusted import lane only; public Node Project creation is not supported.
    const { projectService } = await import("../../server/src/services/projects.js");
    const legacyNodeProject = await projectService(drizzle(sql) as never).create(
      organization.id,
      { name: "Node legacy shared-resource project" },
      { lane: "node", caller: "import" },
    );
    assertCliCompatibleProjectId(legacyNodeProject.id);
    assert.equal(legacyNodeProject.orgId, organization.id);
    const legacyNodeOwner = await sql.unsafe(
      "SELECT owner FROM project_goal_mutation_state WHERE org_id = $1 AND project_id = $2",
      [organization.id, legacyNodeProject.id],
    );
    assert.deepEqual(Array.from(legacyNodeOwner), [{ owner: "node" }]);

    const attachSharedResource = async (projectId: string, note: string, key: string) => {
      const response = await request(
        "/projects/" + projectId + "/resources",
        "POST",
        { resourceId, role: "reference", note, sortOrder: 4, isPrimary: false },
        { "x-rudder-idempotency-key": key },
      );
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.equal(response.body.projectId, projectId);
      assert.equal(response.body.resourceId, resourceId);
      assert.equal(response.body.note, note);
      return response.body;
    };
    const secondRustAttachment = await attachSharedResource(
      secondRustProject.id,
      "Shared with the second Rust Project",
      "resource-attach-rust-" + randomUUID(),
    );
    const legacyNodeAttachment = await attachSharedResource(
      legacyNodeProject.id,
      "Shared with the legacy Node Project",
      "resource-attach-node-" + randomUUID(),
    );
    assert.equal(secondRustAttachment.resourceId, legacyNodeAttachment.resourceId);

    const resourcePath = "/orgs/" + organization.id + "/resources/" + resourceId;
    const resourcePatchKey = "organization-resource-update-" + randomUUID();
    const resourceDeleteKey = "organization-resource-delete-" + randomUUID();
    const resourceOutageKey = "organization-resource-outage-" + randomUUID();
    const resourceMutationKeys = [resourcePatchKey, resourceDeleteKey].sort();
    const resourceProjectIds = [created.id, secondRustProject.id, legacyNodeProject.id];
    const readResourceMutationSnapshot = async (
      targetResourceId = resourceId,
      targetMutationKeys = resourceMutationKeys,
      targetProjectIds = resourceProjectIds,
    ) => {
      const [resourceRows, resourceStateRows, attachmentRows, projectStateRows, receiptRows, activityRows, outboxRows] = await Promise.all([
        sql.unsafe(
          "SELECT id::text AS id, org_id::text AS org_id, name, kind, source_type, locator, description, "
            + "metadata::text AS metadata, created_at::text AS created_at, updated_at::text AS updated_at "
            + "FROM organization_resources WHERE org_id = $1 AND id = $2",
          [organization.id, targetResourceId],
        ),
        sql.unsafe(
          "SELECT resource_id::text AS resource_id, org_id::text AS org_id, owner, "
            + "mutation_version::text AS mutation_version, fence_epoch::text AS fence_epoch "
            + "FROM organization_resource_mutation_state WHERE org_id = $1 AND resource_id = $2",
          [organization.id, targetResourceId],
        ),
        sql.unsafe(
          "SELECT id::text AS id, org_id::text AS org_id, project_id::text AS project_id, "
            + "resource_id::text AS resource_id, role, note, sort_order, is_primary "
            + "FROM project_resource_attachments WHERE org_id = $1 AND resource_id = $2 ORDER BY project_id",
          [organization.id, targetResourceId],
        ),
        sql.unsafe(
          "SELECT project_id::text AS project_id, owner, mutation_version::text AS mutation_version "
            + "FROM project_goal_mutation_state WHERE org_id = $1 AND project_id = ANY($2::uuid[]) ORDER BY project_id",
          [organization.id, targetProjectIds],
        ),
        sql.unsafe(
          "SELECT idempotency_key, command_kind, outcome, activity_id::text AS activity_id, result::text AS result "
            + "FROM organization_mutation_receipts WHERE org_id = $1 AND idempotency_key = ANY($2::text[]) "
            + "ORDER BY idempotency_key",
          [organization.id, targetMutationKeys],
        ),
        sql.unsafe(
          "SELECT id::text AS id, action, entity_type, entity_id FROM activity_log "
            + "WHERE org_id = $1 AND entity_type = 'organization_resource' AND entity_id = $2::text "
            + "AND action IN ('organization.resource.updated', 'organization.resource.deleted') ORDER BY action, id",
          [organization.id, targetResourceId],
        ),
        sql.unsafe(
          "SELECT outbox.activity_id::text AS activity_id FROM organization_mutation_outbox outbox "
            + "JOIN activity_log activity ON activity.id = outbox.activity_id AND activity.org_id = outbox.org_id "
            + "WHERE activity.org_id = $1 AND activity.entity_type = 'organization_resource' "
            + "AND activity.entity_id = $2::text ORDER BY outbox.activity_id",
          [organization.id, targetResourceId],
        ),
      ]);
      return {
        resource: Array.from(resourceRows) as Json[],
        resourceState: Array.from(resourceStateRows) as Json[],
        attachments: Array.from(attachmentRows) as Json[],
        projectStates: Array.from(projectStateRows) as Json[],
        receipts: Array.from(receiptRows) as Json[],
        activities: Array.from(activityRows) as Json[],
        outbox: Array.from(outboxRows) as Json[],
      };
    };

    const beforeResourceUpdate = await readResourceMutationSnapshot();
    assert.equal(beforeResourceUpdate.resource.length, 1);
    assert.equal(beforeResourceUpdate.attachments.length, 3, "shared resource is not attached to all three Projects");
    assert.deepEqual(
      beforeResourceUpdate.attachments.map((attachment) => attachment.project_id).sort(),
      resourceProjectIds.slice().sort(),
    );
    assert.deepEqual(
      beforeResourceUpdate.projectStates.map((project) => project.owner).sort(),
      ["node", "rust", "rust"],
    );

    const resourcePatchInput = {
      name: "Project-create shared resource updated",
      description: "Updated through the public Rust organization-resource route",
      metadata: { fixture: "rust-project-create-real-entry", revision: 2 },
    };
    // A real public request must roll back every effect if atomic audit fails.
    // This trigger exists only in this disposable smoke database.
    await sql.unsafe(
      "CREATE FUNCTION fail_resource_smoke_audit() RETURNS trigger LANGUAGE plpgsql AS $$ "
        + "BEGIN IF NEW.action = 'organization.resource.updated' THEN "
        + "RAISE EXCEPTION 'resource smoke audit failure'; END IF; RETURN NEW; END; $$",
    );
    await sql.unsafe(
      "CREATE TRIGGER fail_resource_smoke_audit_trigger BEFORE INSERT ON activity_log "
        + "FOR EACH ROW EXECUTE FUNCTION fail_resource_smoke_audit()",
    );
    try {
      const auditFailure = await request(resourcePath, "PATCH", resourcePatchInput,
        { "x-rudder-idempotency-key": resourcePatchKey });
      assert.equal(auditFailure.status, 500, JSON.stringify(auditFailure.body));
      assert.deepEqual(await readResourceMutationSnapshot(), beforeResourceUpdate,
        "audit failure committed resource, ownership, attachment, receipt, activity or outbox effects");
    } finally {
      await sql.unsafe("DROP TRIGGER fail_resource_smoke_audit_trigger ON activity_log");
      await sql.unsafe("DROP FUNCTION fail_resource_smoke_audit()");
    }
    const resourcePatchResponse = await request(
      resourcePath,
      "PATCH",
      resourcePatchInput,
      { "x-rudder-idempotency-key": resourcePatchKey },
    );
    assert.equal(resourcePatchResponse.status, 200, JSON.stringify(resourcePatchResponse.body));
    assert.deepEqual(Object.keys(resourcePatchResponse.body).sort(), [
      "createdAt", "description", "id", "kind", "locator", "metadata", "name", "orgId", "sourceType", "updatedAt",
    ].sort(), "resource mutation did not return the existing OrganizationResource response shape");
    assert.equal(resourcePatchResponse.body.id, resourceId);
    assert.equal(resourcePatchResponse.body.orgId, organization.id);
    assert.equal(resourcePatchResponse.body.name, resourcePatchInput.name);
    assert.deepEqual(resourcePatchResponse.body.metadata, resourcePatchInput.metadata);
    const afterResourceUpdate = await readResourceMutationSnapshot();
    assert.equal(afterResourceUpdate.resource[0]?.id, resourceId);
    assert.equal(afterResourceUpdate.resource[0]?.name, resourcePatchInput.name);
    assert.equal(afterResourceUpdate.resource[0]?.description, resourcePatchInput.description);
    assert.deepEqual(JSON.parse(String(afterResourceUpdate.resource[0]?.metadata)), resourcePatchInput.metadata);
    assert.equal(afterResourceUpdate.resourceState[0]?.owner, "rust");
    assert.equal(
      BigInt(afterResourceUpdate.resourceState[0]?.mutation_version),
      BigInt(beforeResourceUpdate.resourceState[0]?.mutation_version) + 1n,
      "resource update did not advance its mutation version",
    );
    assert.deepEqual(afterResourceUpdate.attachments, beforeResourceUpdate.attachments,
      "resource update changed an attachment ID or its metadata");
    assert.deepEqual(afterResourceUpdate.receipts.map((receipt) => receipt.idempotency_key), [resourcePatchKey]);
    assert.equal(afterResourceUpdate.receipts[0]?.command_kind, "organization_resource");
    assert.deepEqual(afterResourceUpdate.activities.map((activity) => activity.action), ["organization.resource.updated"]);
    assert.equal(afterResourceUpdate.outbox.length, 1, "resource update did not commit its outbox effect");

    const resourcePatchReplay = await request(
      resourcePath,
      "PATCH",
      resourcePatchInput,
      { "x-rudder-idempotency-key": resourcePatchKey },
    );
    assert.equal(resourcePatchReplay.status, 200, JSON.stringify(resourcePatchReplay.body));
    assert.deepEqual(resourcePatchReplay.body, resourcePatchResponse.body, "same-key resource update replay changed its response");
    assert.deepEqual(await readResourceMutationSnapshot(), afterResourceUpdate,
      "same-key resource update replay added another receipt or audit");

    const changedResourcePayload = await request(
      resourcePath,
      "PATCH",
      { ...resourcePatchInput, name: "Changed payload under the same resource key" },
      { "x-rudder-idempotency-key": resourcePatchKey },
    );
    assert.equal(changedResourcePayload.status, 409, JSON.stringify(changedResourcePayload.body));
    assert.deepEqual(await readResourceMutationSnapshot(), afterResourceUpdate,
      "changed-payload conflict modified resource, attachments, receipts, or audits");

    const beforeResourceDelete = await readResourceMutationSnapshot();
    const resourceDeleteResponse = await request(
      resourcePath,
      "DELETE",
      undefined,
      { "x-rudder-idempotency-key": resourceDeleteKey },
    );
    assert.equal(resourceDeleteResponse.status, 200, JSON.stringify(resourceDeleteResponse.body));
    assert.deepEqual(resourceDeleteResponse.body, resourcePatchResponse.body,
      "resource delete did not return the original OrganizationResource object");
    const afterResourceDelete = await readResourceMutationSnapshot();
    assert.equal(afterResourceDelete.resource.length, 0, "resource delete left the canonical resource row");
    assert.equal(afterResourceDelete.attachments.length, 0, "resource delete did not cascade all Project attachments");
    assert.equal(afterResourceDelete.resourceState.length, 1, "resource delete removed the mutation tombstone");
    assert.equal(afterResourceDelete.resourceState[0]?.owner, "rust");
    assert.equal(
      BigInt(afterResourceDelete.resourceState[0]?.mutation_version),
      BigInt(beforeResourceDelete.resourceState[0]?.mutation_version) + 1n,
      "resource delete did not advance the resource mutation version",
    );
    assert.equal(afterResourceDelete.projectStates.length, beforeResourceDelete.projectStates.length);
    for (const projectAfterDelete of afterResourceDelete.projectStates) {
      const projectBeforeDelete = beforeResourceDelete.projectStates.find(
        (project) => project.project_id === projectAfterDelete.project_id,
      );
      assert.ok(projectBeforeDelete, "resource deletion removed a Project ownership row");
      assert.equal(projectAfterDelete.owner, projectBeforeDelete.owner, "resource deletion changed a Project owner");
      assert.equal(
        BigInt(projectAfterDelete.mutation_version),
        BigInt(projectBeforeDelete.mutation_version) + 1n,
        "resource deletion did not advance an affected Project version",
      );
    }
    assert.deepEqual(afterResourceDelete.receipts.map((receipt) => receipt.idempotency_key), resourceMutationKeys);
    assert.ok(afterResourceDelete.receipts.every((receipt) => receipt.command_kind === "organization_resource"));
    assert.equal(afterResourceDelete.outbox.length, 2, "resource delete did not commit its outbox effect");
    assert.deepEqual(
      afterResourceDelete.activities.map((activity) => activity.action),
      ["organization.resource.deleted", "organization.resource.updated"],
    );

    const resourceDeleteReplay = await request(
      resourcePath,
      "DELETE",
      undefined,
      { "x-rudder-idempotency-key": resourceDeleteKey },
    );
    assert.equal(resourceDeleteReplay.status, 200, JSON.stringify(resourceDeleteReplay.body));
    assert.deepEqual(resourceDeleteReplay.body, resourcePatchResponse.body, "same-key resource delete replay lost the original resource");
    assert.deepEqual(await readResourceMutationSnapshot(), afterResourceDelete,
      "same-key resource delete replay added another receipt or audit");

    await stop();
    await start();
    const resourceDeleteReplayAfterRestart = await request(
      resourcePath,
      "DELETE",
      undefined,
      { "x-rudder-idempotency-key": resourceDeleteKey },
    );
    assert.equal(resourceDeleteReplayAfterRestart.status, 200, JSON.stringify(resourceDeleteReplayAfterRestart.body));
    assert.deepEqual(resourceDeleteReplayAfterRestart.body, resourcePatchResponse.body,
      "restart replay did not return the original OrganizationResource object");
    assert.deepEqual(await readResourceMutationSnapshot(), afterResourceDelete,
      "restart replay changed resource tombstone, Project versions, receipts, or audits");

    const importedProject = await create("/orgs/" + organization.id + "/projects", {
      name: "Rust Project-create import recovery target",
      description: "Original target Project description",
    });
    assertCliCompatibleProjectId(importedProject.id);
    assert.equal(importedProject.orgId, organization.id);
    assert.equal(typeof importedProject.urlKey, "string");
    const importedProjectOwner = await sql.unsafe(
      "SELECT owner FROM project_goal_mutation_state WHERE org_id = $1 AND project_id = $2",
      [organization.id, importedProject.id],
    );
    assert.deepEqual(Array.from(importedProjectOwner), [{ owner: "rust" }], "import target Project was not Rust-owned");

    const projectImportKey = "project-create-import-" + randomUUID();
    const projectImportInput = buildExistingOrganizationProjectImport({
      targetOrgId: organization.id,
      projectSlug: importedProject.urlKey,
      projectName: importedProject.name,
      description: "Description imported through the public portability API",
      workspaceRepoUrl: "https://example.com/rudder-import-recovery.git",
    });
    const importPreview = await request("/orgs/import/preview", "POST", projectImportInput);
    assert.equal(importPreview.status, 200, JSON.stringify(importPreview.body));
    const previewProject = ((importPreview.body.manifest as Json | undefined)?.projects as Json[] | undefined)?.find(
      (project) => project.slug === importedProject.urlKey,
    );
    assert.ok(previewProject, JSON.stringify(importPreview.body));
    assert.equal((previewProject.workspaces as Json[] | undefined)?.length, 1, JSON.stringify(previewProject));
    assert.equal(
      (previewProject.executionWorkspacePolicy as Json | null)?.defaultProjectWorkspaceKey,
      "primary",
      JSON.stringify(previewProject),
    );
    const projectImportMutationKeys = [
      projectImportMutationKey(projectImportKey, organization.id, importedProject.id, "replace"),
      projectImportMutationKey(projectImportKey, organization.id, importedProject.id, "hydrate"),
    ].sort();
    const applyProjectImport = async (body: Json = projectImportInput) => await request(
      "/orgs/import",
      "POST",
      body,
      { "x-rudder-idempotency-key": projectImportKey },
    );
    const readProjectImportState = async () => {
      const [projectRows, workspaceRows, receiptRows, counts] = await Promise.all([
        sql!.unsafe(
          "SELECT p.id::text AS id, p.org_id::text AS org_id, p.name, p.description, "
            + "p.execution_workspace_policy::text AS execution_workspace_policy, p.updated_at::text AS updated_at, "
            + "state.owner, state.mutation_version::text AS mutation_version, state.fence_epoch::text AS fence_epoch "
            + "FROM projects p LEFT JOIN project_goal_mutation_state state ON state.project_id = p.id "
            + "WHERE p.org_id = $1 AND p.id = $2",
          [organization.id, importedProject.id],
        ),
        sql!.unsafe(
          "SELECT id::text AS id, org_id::text AS org_id, project_id::text AS project_id, name, source_type, "
            + "repo_url, repo_ref, default_ref, visibility, setup_command, cleanup_command, metadata::text AS metadata, is_primary "
            + "FROM project_workspaces WHERE org_id = $1 AND project_id = $2 ORDER BY id",
          [organization.id, importedProject.id],
        ),
        sql!.unsafe(
          "SELECT idempotency_key, command_kind, result->'result'->>'mutation_origin' AS mutation_origin, "
            + "activity_id::text AS activity_id, result::text AS result "
            + "FROM organization_mutation_receipts WHERE org_id = $1 AND idempotency_key = ANY($2::text[]) "
            + "ORDER BY idempotency_key",
          [organization.id, projectImportMutationKeys],
        ),
        sql!.unsafe(
          "SELECT "
            + "(SELECT count(*)::text FROM activity_log WHERE org_id = $1 AND action = 'organization.imported' "
            + "AND entity_type = 'organization' AND entity_id = $1::text) AS organization_imported_activities, "
            + "(SELECT count(*)::text FROM activity_log WHERE org_id = $1 AND action = 'project.updated' "
            + "AND entity_type = 'project' AND entity_id = $2::text) AS project_updated_activities, "
            + "(SELECT count(*)::text FROM organization_mutation_outbox WHERE org_id = $1 "
            + "AND payload->>'action' = 'project.updated' AND payload->>'entityId' = $2::text) AS project_updated_outbox",
          [organization.id, importedProject.id],
        ),
      ]);
      return {
        project: Array.from(projectRows) as Json[],
        workspaces: Array.from(workspaceRows) as Json[],
        receipts: Array.from(receiptRows) as Json[],
        counts: counts[0] as Json,
      };
    };

    const lostHydrationResponse = await applyProjectImport();
    const projectGoalTrace = await readFile(projectGoalRequestTrace, "utf8").catch(() => "");
    assert.equal(
      lostHydrationResponse.status,
      503,
      `${JSON.stringify(lostHydrationResponse.body)}\nRust Project-Goal proxy trace:\n${projectGoalTrace}`,
    );
    assert.equal(
      await readFile(lostHydrationResponseMarker, "utf8"),
      "organization_import_hydration_response_dropped\n",
      "the real Rust hydration reply was not dropped after its commit",
    );
    const afterLostHydrationResponse = await readProjectImportState();
    assert.equal(afterLostHydrationResponse.workspaces.length, 1, "lost reply duplicated or omitted the imported workspace");
    assert.equal(afterLostHydrationResponse.project[0]?.owner, "rust");
    assert.equal(afterLostHydrationResponse.project[0]?.description, "Description imported through the public portability API");
    assert.equal(afterLostHydrationResponse.workspaces[0]?.repo_url, "https://example.com/rudder-import-recovery.git");
    const hydratedPolicy = JSON.parse(
      String(afterLostHydrationResponse.project[0]?.execution_workspace_policy),
    ) as Json;
    assert.equal(
      afterLostHydrationResponse.workspaces[0]?.id,
      hydratedPolicy.defaultProjectWorkspaceId,
      "Rust Project policy did not hydrate to the imported workspace identity",
    );
    assert.deepEqual(
      afterLostHydrationResponse.receipts.map((receipt) => receipt.idempotency_key).sort(),
      projectImportMutationKeys,
      "replace and hydration Rust receipts were not both committed before the lost response",
    );
    assert.ok(afterLostHydrationResponse.receipts.every((receipt) =>
      receipt.command_kind === "project_goal_set_replacement"
        && receipt.mutation_origin === "organization_import"
        && receipt.activity_id === null),
    "import-origin Rust receipts unexpectedly created per-Project activity identities");
    assert.equal(afterLostHydrationResponse.counts.organization_imported_activities, "0");

    const retriedProjectImport = await applyProjectImport();
    assert.equal(retriedProjectImport.status, 200, JSON.stringify(retriedProjectImport.body));
    const importedProjectResult = (retriedProjectImport.body.projects as Json[]).find(
      (project) => project.id === importedProject.id,
    );
    assert.equal(importedProjectResult?.action, "updated");
    const afterImportRetry = await readProjectImportState();
    assert.deepEqual(afterImportRetry.project, afterLostHydrationResponse.project, "same-key retry changed Rust Project state");
    assert.deepEqual(afterImportRetry.workspaces, afterLostHydrationResponse.workspaces, "same-key retry created another workspace");
    assert.deepEqual(afterImportRetry.receipts, afterLostHydrationResponse.receipts, "same-key retry created another Rust receipt");
    assert.equal(afterImportRetry.counts.organization_imported_activities, "1", "successful retry did not log one aggregate import activity");
    assert.equal(afterImportRetry.counts.project_updated_activities, "0", "import-origin Project patch emitted project.updated activity");
    assert.equal(afterImportRetry.counts.project_updated_outbox, "0", "import-origin Project patch emitted project.updated outbox event");

    const beforeChangedWorkspaceConflict = await readProjectImportState();
    const changedWorkspaceImport = buildExistingOrganizationProjectImport({
      targetOrgId: organization.id,
      projectSlug: importedProject.urlKey,
      projectName: importedProject.name,
      description: "Description imported through the public portability API",
      workspaceRepoUrl: "https://example.com/changed-rudder-import-recovery.git",
    });
    const changedWorkspaceConflict = await applyProjectImport(changedWorkspaceImport);
    assert.equal(changedWorkspaceConflict.status, 409, JSON.stringify(changedWorkspaceConflict.body));
    assert.match(String(changedWorkspaceConflict.body.error), /workspace import key conflicts/i);
    assert.deepEqual(
      await readProjectImportState(),
      beforeChangedWorkspaceConflict,
      "changed workspace payload modified rows, Rust state/receipts, or import activities before conflict",
    );

    const immediateImportReplay = await applyProjectImport();
    assert.equal(immediateImportReplay.status, 200, JSON.stringify(immediateImportReplay.body));
    assert.deepEqual(await readProjectImportState(), afterImportRetry,
      "same-key successful import replay changed Project, workspace, receipts, audit or outbox");
    const concurrentImportReplays = await Promise.all([applyProjectImport(), applyProjectImport()]);
    for (const response of concurrentImportReplays) {
      assert.equal(response.status, 200, JSON.stringify(response.body));
    }
    assert.deepEqual(await readProjectImportState(), afterImportRetry,
      "concurrent same-key successful import replay changed Project, workspace, receipts, audit or outbox");
    await stop();
    await start();
    const restartedImportReplay = await applyProjectImport();
    assert.equal(restartedImportReplay.status, 200, JSON.stringify(restartedImportReplay.body));
    const afterRestartedImportReplay = await readProjectImportState();
    assert.deepEqual(afterRestartedImportReplay, afterImportRetry,
      "same-key successful import replay after restart changed Project, workspace, receipts, audit or outbox");

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
        currentServer().apiUrl,
        "--data-dir",
        path.join(home, "cli-data"),
        "--full-ids",
        "--json",
      ],
      repoRoot,
      {
        ...process.env,
        RUDDER_API_URL: currentServer().apiUrl,
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
        RUDDER_API_URL: currentServer().apiUrl,
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
    const [mcpPersistedProject] = await sql.unsafe(
      "SELECT id::text AS id, org_id::text AS org_id, name FROM projects WHERE org_id = $1 AND name = $2",
      [organization.id, mcpName],
    );
    assert.ok(mcpPersistedProject, "MCP Project-create did not persist a Project in the requested organization");
    assertCliCompatibleProjectId(mcpPersistedProject.id);
    assert.equal(mcpPersistedProject.org_id, organization.id);
    assert.equal(mcpProject.id, "prj_" + mcpPersistedProject.id.slice(0, 8), "MCP Project reference did not map to its persisted UUID");
    assert.equal(mcpProject.name, mcpName);
    const mcpOwner = await sql.unsafe(
      "SELECT owner FROM project_goal_mutation_state WHERE org_id = $1 AND project_id = $2",
      [organization.id, mcpPersistedProject.id],
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
    const resourceSnapshotBeforeAgentDenials = await readResourceMutationSnapshot();
    const resourceOrganizationScopeDenied = await request(
      "/orgs/" + foreignOrganization.id + "/resources/" + resourceId,
      "PATCH",
      { name: "Must not cross organization scope" },
      scopedHeaders,
    );
    assert.equal(resourceOrganizationScopeDenied.status, 403, JSON.stringify(resourceOrganizationScopeDenied.body));
    assert.deepEqual(await readResourceMutationSnapshot(), resourceSnapshotBeforeAgentDenials,
      "cross-organization resource mutation changed persisted state");
    const resourceBoardOnlyDenied = await request(
      resourcePath,
      "PATCH",
      { name: "Agent must not update an Organization Resource" },
      scopedHeaders,
    );
    assert.equal(resourceBoardOnlyDenied.status, 403, JSON.stringify(resourceBoardOnlyDenied.body));
    assert.deepEqual(await readResourceMutationSnapshot(), resourceSnapshotBeforeAgentDenials,
      "Agent Organization Resource denial changed persisted state");
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
    assert.equal(foundationChildren.length, 1, "expected one proxy child launched from this smoke's private binary copy");
    const nativeFoundationPid = Number(await readFile(nativePidMarker, "utf8"));
    assert.ok(Number.isSafeInteger(nativeFoundationPid) && nativeFoundationPid > 0, "proxy did not record its Rust child PID");
    assert.deepEqual(
      ownedFoundationPids(processListing, foundationChildren[0]!, nativeBinaryPath),
      [nativeFoundationPid],
      "expected exactly the proxy-owned Rust foundation child before outage injection",
    );
    await rename(binaryPath, binaryPath + ".disabled");
    process.kill(nativeFoundationPid, "SIGKILL");
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
    const resourceSnapshotBeforeOutage = await readResourceMutationSnapshot(
      outageResourceId,
      [resourceOutageKey],
      [created.id],
    );
    assert.equal(resourceSnapshotBeforeOutage.resource.length, 1);
    assert.equal(resourceSnapshotBeforeOutage.resourceState[0]?.owner, "rust");
    assert.equal(resourceSnapshotBeforeOutage.attachments.length, 1);
    const resourceOutageResponse = await request(
      "/orgs/" + organization.id + "/resources/" + outageResourceId,
      "PATCH",
      { name: "Must not be written while Rust is unavailable" },
      { "x-rudder-idempotency-key": resourceOutageKey },
    );
    assert.equal(resourceOutageResponse.status, 503, JSON.stringify(resourceOutageResponse.body));
    assert.deepEqual(await readResourceMutationSnapshot(outageResourceId, [resourceOutageKey], [created.id]), resourceSnapshotBeforeOutage,
      "Rust resource outage fell back to a Node write or created an audit/receipt");

    console.log(JSON.stringify({
      marker: "RUST_PROJECT_CREATE_AUTHOR_SMOKE",
      organizationId: organization.id,
      projectId: created.id,
      persistedOwner: "rust",
      inlineResourceId: resourceId,
      sharedResourceProjectIds: resourceProjectIds,
      resourceUpdateStatus: resourcePatchResponse.status,
      resourceUpdateReplayStatus: resourcePatchReplay.status,
      resourceChangedPayloadStatus: changedResourcePayload.status,
      resourceDeleteStatus: resourceDeleteResponse.status,
      resourceDeleteReplayStatus: resourceDeleteReplay.status,
      resourceDeleteReplayAfterRestartStatus: resourceDeleteReplayAfterRestart.status,
      resourceOutageStatus: resourceOutageResponse.status,
      resourceDeleteReceiptCount: afterResourceDelete.receipts.length,
      resourceDeleteAuditCount: afterResourceDelete.activities.length,
      libraryReadme: "node-compatible-and-ready",
      keyedReplay: "exact",
      replayAfterRestart: "exact",
      subsequentMutation: "persisted-owner-routed",
      cliProjectId: cliProject.id,
      mcpProjectId: mcpProject.id,
      importedProjectId: importedProject.id,
      importedWorkspaceId: afterImportRetry.workspaces[0]?.id,
      importLostHydrationResponseStatus: lostHydrationResponse.status,
      importRetryStatus: retriedProjectImport.status,
      importImmediateReplayStatus: immediateImportReplay.status,
      importConcurrentReplayStatuses: concurrentImportReplays.map((response) => response.status),
      importRestartReplayStatus: restartedImportReplay.status,
      importRestartAggregateActivities: afterRestartedImportReplay.counts.organization_imported_activities,
      importAggregateActivities: afterImportRetry.counts.organization_imported_activities,
      importProjectUpdatedActivities: afterImportRetry.counts.project_updated_activities,
      importProjectUpdatedOutbox: afterImportRetry.counts.project_updated_outbox,
      changedWorkspacePayloadStatus: changedWorkspaceConflict.status,
      crossOrganizationDenied: foreignDenied.status,
      terminatedActorDenied: terminatedDenied.status,
      rustOutageCreateStatus: outageResponse.status,
      outageNodeFallback: false,
    }));
  } finally {
    const cleanupErrors: unknown[] = [];
    try { await sql?.end({ timeout: 2 }); } catch (error) { cleanupErrors.push(error); }
    const activeServer = current as ServerHandle | null;
    if (activeServer) {
      try { await activeServer.stop(); } catch (error) { cleanupErrors.push(error); }
      try { await activeServer.dispose(); } catch (error) { cleanupErrors.push(error); }
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
