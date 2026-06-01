import { randomBytes, createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agentApiKeys,
  agents,
  applyPendingMigrations,
  activityLog,
  createDb,
  ensurePostgresDatabase,
  issueAttachments,
  issueComments,
  issues,
  labels,
  organizations,
} from "@rudderhq/db";
import type {
  AgentDetail,
  AgentSkillEntry,
  AgentSkillSnapshot,
  Approval,
  ApprovalComment,
  Issue,
  IssueComment,
  IssueCommitReport,
  IssueDocument,
  IssueLabel,
  Project,
  OrganizationWorkspaceFileDetail,
  OrganizationWorkspaceFileList,
  OrganizationSkillDetail,
  OrganizationSkillFileDetail,
  OrganizationSkillListItem,
  OrganizationSkillLocalScanResult,
} from "@rudderhq/shared";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

type ServerProcess = ChildProcess;

type AgentInboxItem = {
  id: string;
  identifier: string | null;
  status: string;
  title: string;
};

type AgentConfigurationSnapshot = {
  id: string;
  orgId: string;
  name: string;
  role: string;
  status: string;
  agentRuntimeType: string;
  reportsTo: string | null;
  updatedAt: string;
};

type AgentHireResult = {
  agent: {
    id: string;
    status: string;
    name: string;
  };
  approval: Approval | null;
};

let latestServerOutput = { stdout: [] as string[], stderr: [] as string[] };
const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createApiKeyToken() {
  return `pcp_${randomBytes(24).toString("hex")}`;
}

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const externalConnectionString = process.env.RUDDER_E2E_DATABASE_URL?.trim();
  if (externalConnectionString) {
    await applyPendingMigrations(externalConnectionString);
    return { connectionString: externalConnectionString, dataDir: "", instance: null };
  }

  const dataDir = mkdtempSync(path.join(os.tmpdir(), "rudder-agent-cli-db-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);

  return { connectionString, dataDir, instance };
}

function writeTestConfig(configPath: string, tempRoot: string, port: number, connectionString: string) {
  const config = {
    $meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "doctor",
    },
    database: {
      mode: "postgres",
      connectionString,
      embeddedPostgresDataDir: path.join(tempRoot, "embedded-db"),
      embeddedPostgresPort: 54329,
      backup: {
        enabled: false,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(tempRoot, "backups"),
      },
    },
    logging: {
      mode: "file",
      logDir: path.join(tempRoot, "logs"),
    },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port,
      allowedHostnames: [],
      serveUi: false,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: path.join(tempRoot, "storage"),
      },
      s3: {
        bucket: "rudder",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: path.join(tempRoot, "secrets", "master.key"),
      },
    },
  };

  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function createServerEnv(configPath: string, port: number, connectionString: string, instanceId: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("RUDDER_")) delete env[key];
  }
  delete env.DATABASE_URL;
  delete env.PORT;
  delete env.HOST;
  delete env.SERVE_UI;
  delete env.HEARTBEAT_SCHEDULER_ENABLED;

  env.RUDDER_CONFIG = configPath;
  env.RUDDER_INSTANCE_ID = instanceId;
  env.RUDDER_HOME = path.join(path.dirname(configPath), "..", "rudder-home");
  env.DATABASE_URL = connectionString;
  env.HOST = "127.0.0.1";
  env.PORT = String(port);
  env.SERVE_UI = "false";
  env.RUDDER_DB_BACKUP_ENABLED = "false";
  env.HEARTBEAT_SCHEDULER_ENABLED = "false";
  env.RUDDER_MIGRATION_AUTO_APPLY = "true";
  env.RUDDER_UI_DEV_MIDDLEWARE = "false";

  return env;
}

function createCliEnv(overrides: Record<string, string>) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("RUDDER_")) delete env[key];
  }
  delete env.DATABASE_URL;
  delete env.PORT;
  delete env.HOST;
  delete env.SERVE_UI;
  delete env.RUDDER_DB_BACKUP_ENABLED;
  delete env.HEARTBEAT_SCHEDULER_ENABLED;
  delete env.RUDDER_MIGRATION_AUTO_APPLY;
  delete env.RUDDER_UI_DEV_MIDDLEWARE;
  return {
    ...env,
    ...overrides,
  };
}

async function stopServerProcess(child: ServerProcess | null) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 5_000);
  });
}

async function waitForServer(
  apiBase: string,
  child: ServerProcess,
  output: { stdout: string[]; stderr: string[] },
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (child.exitCode !== null) {
      throw new Error(
        `rudder run exited before healthcheck succeeded.\nstdout:\n${output.stdout.join("")}\nstderr:\n${output.stderr.join("")}`,
      );
    }

    try {
      const res = await fetch(`${apiBase}/api/health`);
      if (res.ok) return;
    } catch {
      // Server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for ${apiBase}/api/health.\nstdout:\n${output.stdout.join("")}\nstderr:\n${output.stderr.join("")}`,
  );
}

async function runCliJson<T>(
  args: string[],
  opts: {
    apiBase: string;
    configPath: string;
    env: Record<string, string>;
    stdin?: string;
  },
): Promise<T> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "cli/node_modules/tsx/dist/cli.mjs",
        "cli/src/index.ts",
        ...args,
        "--api-base",
        opts.apiBase,
        "--config",
        opts.configPath,
        "--json",
      ],
      {
        cwd: repoRoot,
        env: createCliEnv(opts.env),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (code !== 0) {
        reject(
          new Error(
            `CLI exited with code ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}\nserver stdout:\n${latestServerOutput.stdout.join("")}\nserver stderr:\n${latestServerOutput.stderr.join("")}`,
          ),
        );
        return;
      }

      try {
        resolve(JSON.parse(stdout.trim()) as T);
      } catch (error) {
        reject(
          new Error(
            `Failed to parse CLI JSON output: ${error}\nstdout:\n${stdout}\nstderr:\n${stderr}\nserver stdout:\n${latestServerOutput.stdout.join("")}\nserver stderr:\n${latestServerOutput.stderr.join("")}`,
          ),
        );
      }
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to spawn CLI: ${error.message}`));
    });

    child.stdin?.end(opts.stdin ?? "");
  });
}

describe("agent CLI e2e", () => {
  let tempRoot = "";
  let configPath = "";
  let apiBase = "";
  let connectionString = "";
  let dbDataDir = "";
  let dbInstance: EmbeddedPostgresInstance | null = null;
  let serverProcess: ServerProcess | null = null;

  let orgId = "";
  let agentId = "";
  let peerAgentId = "";
  let agentKey = "";
  let issueId = "";
  let firstCommentId = "";
  let secondCommentId = "";
  let localSkillRoot = "";

  const runId = randomUUID();

  beforeAll(async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "rudder-agent-cli-e2e-"));
    configPath = path.join(tempRoot, "config", "config.json");

    const started = await startTempDatabase();
    connectionString = started.connectionString;
    dbDataDir = started.dataDir;
    dbInstance = started.instance;

    const port = await getAvailablePort();
    writeTestConfig(configPath, tempRoot, port, started.connectionString);
    apiBase = `http://127.0.0.1:${port}`;

    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    latestServerOutput = { stdout: [], stderr: [] };
    const instanceId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    serverProcess = spawn(
      "pnpm",
      ["--silent", "rudder", "run", "--config", configPath],
      {
        cwd: repoRoot,
        env: createServerEnv(configPath, port, started.connectionString, instanceId),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    serverProcess.stdout?.on("data", (chunk) => latestServerOutput.stdout.push(String(chunk)));
    serverProcess.stderr?.on("data", (chunk) => latestServerOutput.stderr.push(String(chunk)));
    await waitForServer(apiBase, serverProcess, latestServerOutput);

    const db = createDb(started.connectionString);

    orgId = randomUUID();
    await db.execute(sql`
      insert into organizations (
        id,
        url_key,
        name,
        description,
        status,
        issue_prefix,
        issue_counter,
        budget_monthly_cents,
        spent_monthly_cents,
        require_board_approval_for_new_agents,
        default_chat_issue_creation_mode
      ) values (
        ${orgId},
        ${"cli-migration-org"},
        ${"CLI Migration Org"},
        ${"Organization for agent CLI e2e"},
        ${"active"},
        ${"CLI"},
        ${0},
        ${0},
        ${0},
        ${false},
        ${"manual_approval"}
      )
    `);

    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "CLI CEO",
      role: "ceo",
      title: "CLI CEO",
      status: "running",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { cwd: tempRoot },
      runtimeConfig: {},
      permissions: { canCreateAgents: true, canManageSkills: true },
    });
    peerAgentId = randomUUID();
    await db.insert(agents).values({
      id: peerAgentId,
      orgId,
      name: "CLI Peer",
      role: "engineer",
      title: "CLI Peer",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { cwd: tempRoot },
      runtimeConfig: {},
    });

    agentKey = createApiKeyToken();
    await db.insert(agentApiKeys).values({
      agentId,
      orgId,
      name: "agent-cli-e2e",
      keyHash: hashToken(agentKey),
    });

    await db.execute(sql`
      insert into heartbeat_runs (
        id,
        org_id,
        agent_id,
        invocation_source,
        trigger_detail,
        status,
        started_at,
        created_at,
        updated_at
      ) values (
        ${runId},
        ${orgId},
        ${agentId},
        ${"on_demand"},
        ${"test"},
        ${"started"},
        now(),
        now(),
        now()
      )
    `);

    issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      orgId,
      title: "Finish agent CLI migration",
      description: "Validate the CLI-only heartbeat path.",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      createdByUserId: "local-board",
    });

    firstCommentId = randomUUID();
    secondCommentId = randomUUID();
    const firstCommentAt = new Date(Date.now() - 2_000);
    const secondCommentAt = new Date(Date.now() - 1_000);
    await db.insert(issueComments).values([
      {
        id: firstCommentId,
        orgId,
        issueId,
        authorUserId: "local-board",
        body: "Initial brief.",
        createdAt: firstCommentAt,
        updatedAt: firstCommentAt,
      },
      {
        id: secondCommentId,
        orgId,
        issueId,
        authorUserId: "local-board",
        body: "New requirement landed.",
        createdAt: secondCommentAt,
        updatedAt: secondCommentAt,
      },
    ]);

    localSkillRoot = path.join(tempRoot, "local-skills");
    const localSkillDir = path.join(localSkillRoot, "skills", "cli-e2e-skill");
    mkdirSync(localSkillDir, { recursive: true });
    writeFileSync(
      path.join(localSkillDir, "SKILL.md"),
      `---\nname: CLI E2E Skill\ndescription: Skill used by the agent CLI e2e regression.\n---\n\n# CLI E2E Skill\n\nUse this skill for CLI migration testing.\n`,
      "utf8",
    );
  }, 60_000);

  afterAll(async () => {
    await stopServerProcess(serverProcess);
    await dbInstance?.stop();
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    if (dbDataDir) rmSync(dbDataDir, { recursive: true, force: true });
  });

  it("runs the CLI-only heartbeat path", { timeout: 60_000 }, async () => {
    const env = {
      RUDDER_API_KEY: agentKey,
      RUDDER_ORG_ID: orgId,
      RUDDER_AGENT_ID: agentId,
      RUDDER_RUN_ID: runId,
    };

    const me = await runCliJson<AgentDetail>(["agent", "me"], {
      apiBase,
      configPath,
      env,
    });
    expect(me.id).toBe(agentId);

    const inbox = await runCliJson<AgentInboxItem[]>(["agent", "inbox"], {
      apiBase,
      configPath,
      env,
    });
    expect(inbox.some((item) => item.id === issueId)).toBe(true);

    const checkedOut = await runCliJson<Issue>(["issue", "checkout", issueId], {
      apiBase,
      configPath,
      env,
    });
    expect(checkedOut.assigneeAgentId).toBe(agentId);
    expect(checkedOut.status).toBe("in_progress");

    const context = await runCliJson<{
      issue: { id: string };
      wakeComment: { id: string } | null;
      commentCursor: { totalComments: number; latestCommentId: string | null };
    }>(["issue", "context", issueId, "--wake-comment-id", secondCommentId], {
      apiBase,
      configPath,
      env,
    });
    expect(context.issue.id).toBe(issueId);
    expect(context.wakeComment?.id).toBe(secondCommentId);
    expect(context.commentCursor.totalComments).toBeGreaterThanOrEqual(2);
    expect(context.commentCursor.latestCommentId).toBe(secondCommentId);

    const comments = await runCliJson<IssueComment[]>(
      ["issue", "comments", "list", issueId, "--after", firstCommentId, "--order", "asc"],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(comments.map((comment) => comment.id)).toContain(secondCommentId);
    expect(comments.length).toBeGreaterThanOrEqual(1);

    const commentSearch = await runCliJson<Issue[]>(["issue", "search", "New requirement landed"], {
      apiBase,
      configPath,
      env,
    });
    expect(commentSearch.map((issue) => issue.id)).toContain(issueId);

    const commit = await runCliJson<IssueCommitReport>(
      [
        "issue",
        "commit",
        issueId,
        "--sha",
        "ABC1234def5678",
        "--message",
        "fix: report code commit",
        "--branch",
        "feature/commit-activity",
        "--repo-path",
        tempRoot,
        "--count",
        "2",
      ],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(commit).toMatchObject({
      ok: true,
      issueId,
      sha: "abc1234def5678",
      shortSha: "abc1234",
      subject: "fix: report code commit",
      runId,
    });

    const db = createDb(connectionString);
    const commitActivities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.code_committed"));
    const commitActivity = commitActivities.find((row) => row.entityId === issueId);
    expect(commitActivity).toBeTruthy();
    expect(commitActivity).toMatchObject({
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId,
      entityType: "issue",
      entityId: issueId,
    });
    expect(commitActivity?.details).toMatchObject({
      sha: "abc1234def5678",
      shortSha: "abc1234",
      subject: "fix: report code commit",
      branch: "feature/commit-activity",
      repoPath: tempRoot,
      commitCount: 2,
    });

    const doneCommentFile = path.join(tempRoot, "commit-activity-done.md");
    writeFileSync(doneCommentFile, "Completed via CLI.", "utf8");
    const done = await runCliJson<Issue>(["issue", "done", issueId, "--comment-file", doneCommentFile], {
      apiBase,
      configPath,
      env,
    });
    expect(done.status).toBe("done");
  });

  it("defaults agent-created issues to the creating agent", { timeout: 60_000 }, async () => {
    const env = {
      RUDDER_API_KEY: agentKey,
      RUDDER_ORG_ID: orgId,
      RUDDER_AGENT_ID: agentId,
      RUDDER_RUN_ID: runId,
    };

    const createdByCli = await runCliJson<Issue>(
      ["issue", "create", "--title", "Agent default assignee", "--status", "todo"],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(createdByCli.createdByAgentId).toBe(agentId);
    expect(createdByCli.assigneeAgentId).toBe(agentId);
    expect(createdByCli.assigneeUserId).toBeNull();

    const explicitAssignee = await runCliJson<Issue>(
      [
        "issue",
        "create",
        "--title",
        "Agent explicit assignee",
        "--status",
        "todo",
        "--assignee-agent-id",
        peerAgentId,
      ],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(explicitAssignee.createdByAgentId).toBe(agentId);
    expect(explicitAssignee.assigneeAgentId).toBe(peerAgentId);

    const explicitNullRes = await fetch(`${apiBase}/api/orgs/${orgId}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Agent explicit null assignee",
        status: "backlog",
        assigneeAgentId: null,
        assigneeUserId: null,
      }),
    });
    expect(explicitNullRes.ok).toBe(true);
    const explicitNull = (await explicitNullRes.json()) as Issue;
    expect(explicitNull.createdByAgentId).toBe(agentId);
    expect(explicitNull.assigneeAgentId).toBeNull();
    expect(explicitNull.assigneeUserId).toBeNull();

    const boardRes = await fetch(`${apiBase}/api/orgs/${orgId}/issues`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Board unassigned issue",
        status: "backlog",
      }),
    });
    expect(boardRes.ok).toBe(true);
    const boardIssue = (await boardRes.json()) as Issue;
    expect(boardIssue.createdByAgentId).toBeNull();
    expect(boardIssue.assigneeAgentId).toBeNull();
    expect(boardIssue.assigneeUserId).toBeNull();
  });

  it("lets agents create, read, list, and update projects through the CLI", { timeout: 60_000 }, async () => {
    const env = {
      RUDDER_API_KEY: agentKey,
      RUDDER_ORG_ID: orgId,
      RUDDER_AGENT_ID: agentId,
      RUDDER_RUN_ID: runId,
    };

    const created = await runCliJson<Project>(
      [
        "project",
        "create",
        "--name",
        "Agent Planned Project",
        "--description",
        "Created from the agent CLI e2e path.",
        "--status",
        "planned",
        "--lead-agent-id",
        agentId,
      ],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(created.orgId).toBe(orgId);
    expect(created.name).toBe("Agent Planned Project");
    expect(created.status).toBe("planned");
    expect(created.leadAgentId).toBe(agentId);

    const listed = await runCliJson<Project[]>(["project", "list"], {
      apiBase,
      configPath,
      env,
    });
    expect(listed.some((project) => project.id === created.id)).toBe(true);

    const fetched = await runCliJson<Project>(["project", "get", created.id], {
      apiBase,
      configPath,
      env,
    });
    expect(fetched.id).toBe(created.id);

    const updated = await runCliJson<Project>(
      ["project", "update", created.id, "--status", "in_progress", "--target-date", "2026-07-01"],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(updated.id).toBe(created.id);
    expect(updated.status).toBe("in_progress");
    expect(updated.targetDate).toBe("2026-07-01");

    const db = createDb(connectionString);
    const projectActivities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, created.id));
    expect(projectActivities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "project.created",
          actorType: "agent",
          actorId: agentId,
          agentId,
          runId,
        }),
        expect.objectContaining({
          action: "project.updated",
          actorType: "agent",
          actorId: agentId,
          agentId,
          runId,
        }),
      ]),
    );
  });

  it("lists issue labels and requires agent-created issues to choose one once the label taxonomy is mature", { timeout: 60_000 }, async () => {
    const db = createDb(connectionString);
    const labelRows = ["Operations", "Research", "Engineering", "Design", "Customer"].map((name) => ({
      id: randomUUID(),
      orgId,
      name,
      color: "#2563eb",
    }));
    await db.insert(labels).values(labelRows);

    const env = {
      RUDDER_API_KEY: agentKey,
      RUDDER_ORG_ID: orgId,
      RUDDER_AGENT_ID: agentId,
      RUDDER_RUN_ID: runId,
    };

    const listed = await runCliJson<IssueLabel[]>(["issue", "labels", "list"], {
      apiBase,
      configPath,
      env,
    });
    expect(listed.map((label) => label.name)).toEqual(expect.arrayContaining(labelRows.map((label) => label.name)));

    await expect(
      runCliJson<Issue>(["issue", "create", "--title", "Agent issue without label", "--status", "todo"], {
        apiBase,
        configPath,
        env,
      }),
    ).rejects.toThrow("Choose at least one with --label-id <id> or --label <name>");

    const byName = await runCliJson<Issue>(
      ["issue", "create", "--title", "Agent issue with label name", "--status", "todo", "--label", "Operations"],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(byName.labelIds).toEqual([labelRows[0]!.id]);

    const byId = await runCliJson<Issue>(
      ["issue", "create", "--title", "Agent issue with label id", "--status", "todo", "--label-id", labelRows[1]!.id],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(byId.labelIds).toEqual([labelRows[1]!.id]);

    const child = await runCliJson<Issue>(
      ["issue", "create", "--title", "Agent sub-issue inherits parent label", "--status", "todo", "--parent-id", byId.id],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(child.parentId).toBe(byId.id);
    expect(child.labelIds).toEqual([labelRows[1]!.id]);
  });

  it("uploads images into issue comments from the CLI", { timeout: 60_000 }, async () => {
    const db = createDb(connectionString);
    const imageIssueId = randomUUID();
    await db.insert(issues).values({
      id: imageIssueId,
      orgId,
      title: "Comment with uploaded image",
      description: "Validate CLI image uploads into issue comments.",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      createdByUserId: "local-board",
    });

    const env = {
      RUDDER_API_KEY: agentKey,
      RUDDER_ORG_ID: orgId,
      RUDDER_AGENT_ID: agentId,
      RUDDER_RUN_ID: runId,
    };
    await runCliJson<Issue>(["issue", "checkout", imageIssueId], {
      apiBase,
      configPath,
      env,
    });

    const imagePath = path.join(tempRoot, "comment-proof.png");
    writeFileSync(imagePath, Buffer.from(tinyPngBase64, "base64"));

    const imageCommentFile = path.join(tempRoot, "comment-image-body.md");
    writeFileSync(imageCommentFile, "Progress with image.", "utf8");
    const comment = await runCliJson<IssueComment>(
      ["issue", "comment", imageIssueId, "--body-file", imageCommentFile, "--image", imagePath],
      {
        apiBase,
        configPath,
        env,
      },
    );

    expect(comment.body).toContain("Progress with image.");
    expect(comment.body).toContain("![comment-proof.png](/api/attachments/");
    expect(comment.body).toContain("/content)");

    const attachments = await db
      .select()
      .from(issueAttachments)
      .where(eq(issueAttachments.issueId, imageIssueId));
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.usage).toBe("comment_inline");

    const commentActivities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.comment_added"));
    const commentActivity = commentActivities.find((row) => row.details?.commentId === comment.id);
    expect(commentActivity).toMatchObject({
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId,
      entityType: "issue",
      entityId: imageIssueId,
    });
  });

  it("reads issue comments from files and stdin", { timeout: 60_000 }, async () => {
    const db = createDb(connectionString);
    const fileIssueId = randomUUID();
    await db.insert(issues).values({
      id: fileIssueId,
      orgId,
      title: "Comment from file",
      description: "Validate safe CLI comment input from files.",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      createdByUserId: "local-board",
    });

    const env = {
      RUDDER_API_KEY: agentKey,
      RUDDER_ORG_ID: orgId,
      RUDDER_AGENT_ID: agentId,
      RUDDER_RUN_ID: runId,
    };
    await runCliJson<Issue>(["issue", "checkout", fileIssueId], {
      apiBase,
      configPath,
      env,
    });

    const commentFile = path.join(tempRoot, "issue-comment.md");
    const fileBody = [
      "File close-out keeps shell-sensitive Markdown literal.",
      "",
      "- command: `pnpm test:e2e`",
      "- substitution: $(echo should-not-run)",
    ].join("\n");
    writeFileSync(commentFile, fileBody, "utf8");

    const comment = await runCliJson<IssueComment>(
      ["issue", "comment", fileIssueId, "--body-file", commentFile],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(comment.body).toBe(fileBody);

    const doneBody = [
      "Stdin close-out also keeps Markdown literal.",
      "",
      "- command: `pnpm --filter @rudderhq/ui typecheck`",
      "- substitution: $(pwd)",
    ].join("\n");
    const done = await runCliJson<Issue & { comment?: IssueComment | null }>(
      ["issue", "done", fileIssueId, "--comment-file", "-"],
      {
        apiBase,
        configPath,
        env,
        stdin: doneBody,
      },
    );
    expect(done.status).toBe("done");
    expect(done.comment?.body).toBe(doneBody);

    const updateIssueId = randomUUID();
    await db.insert(issues).values({
      id: updateIssueId,
      orgId,
      title: "Update from file",
      description: "Validate safe CLI update comment input from files.",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      createdByUserId: "local-board",
    });
    await runCliJson<Issue>(["issue", "checkout", updateIssueId], {
      apiBase,
      configPath,
      env,
    });

    const updateCommentFile = path.join(tempRoot, "issue-update-comment.md");
    const updateBody = "Update file keeps `inline code` and $(shell text) literal.";
    writeFileSync(updateCommentFile, updateBody, "utf8");
    const updated = await runCliJson<Issue & { comment?: IssueComment | null }>(
      ["issue", "update", updateIssueId, "--comment-file", updateCommentFile],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(updated.comment?.body).toBe(updateBody);

    const blockIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockIssueId,
      orgId,
      title: "Block from file",
      description: "Validate safe CLI blocker input from files.",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      createdByUserId: "local-board",
    });
    await runCliJson<Issue>(["issue", "checkout", blockIssueId], {
      apiBase,
      configPath,
      env,
    });

    const blockCommentFile = path.join(tempRoot, "issue-block-comment.md");
    const blockBody = "Blocked with `command` evidence and $(literal) shell text.";
    writeFileSync(blockCommentFile, blockBody, "utf8");
    const blocked = await runCliJson<Issue & { comment?: IssueComment | null }>(
      ["issue", "block", blockIssueId, "--comment-file", blockCommentFile],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(blocked.status).toBe("blocked");
    expect(blocked.comment?.body).toBe(blockBody);

    const reviewIssueId = randomUUID();
    await db.insert(issues).values({
      id: reviewIssueId,
      orgId,
      title: "Review from file",
      description: "Validate safe CLI review comment input from files.",
      status: "in_review",
      priority: "high",
      assigneeAgentId: peerAgentId,
      reviewerAgentId: agentId,
      createdByUserId: "local-board",
    });

    const reviewCommentFile = path.join(tempRoot, "issue-review-comment.md");
    const reviewBody = "Review file keeps `pnpm test:run` and $(literal) text.";
    writeFileSync(reviewCommentFile, reviewBody, "utf8");
    const reviewed = await runCliJson<Issue & { comment?: IssueComment | null }>(
      ["issue", "review", reviewIssueId, "--decision", "approve", "--comment-file", reviewCommentFile],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(reviewed.status).toBe("done");
    expect(reviewed.comment?.body).toBe(reviewBody);

    const documentBodyFile = path.join(tempRoot, "issue-plan-document.md");
    const documentBody = "Plan document keeps `commands` and $(literal) text.";
    writeFileSync(documentBodyFile, documentBody, "utf8");
    await expect(
      runCliJson<IssueDocument>(["issue", "documents", "put", fileIssueId, "plan", "--body-file", documentBodyFile], {
        apiBase,
        configPath,
        env,
      }),
    ).rejects.toThrow("Agents must write new durable docs with `rudder library file put docs/<file>.md`");

    const libraryBodyFile = path.join(tempRoot, "agent-team-design.md");
    const libraryBody = "# Agent Team Design\n\nThis belongs in Docs.";
    writeFileSync(libraryBodyFile, libraryBody, "utf8");
    const libraryFile = await runCliJson<OrganizationWorkspaceFileDetail>(
      ["library", "file", "put", "docs/agent-team-design.md", "--body-file", libraryBodyFile],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(libraryFile).toMatchObject({
      filePath: "docs/agent-team-design.md",
      content: libraryBody,
      contentType: "text/markdown",
      previewKind: "text",
    });

    const libraryListing = await runCliJson<OrganizationWorkspaceFileList>(["library", "file", "list", "docs"], {
      apiBase,
      configPath,
      env,
    });
    expect(libraryListing.entries.map((entry) => entry.path)).toContain("docs/agent-team-design.md");

    const defaultLibraryListing = await runCliJson<OrganizationWorkspaceFileList>(["library", "file", "list"], {
      apiBase,
      configPath,
      env,
    });
    expect(defaultLibraryListing.directoryPath).toBe("docs");

    await expect(
      runCliJson<OrganizationWorkspaceFileDetail>(
        ["library", "file", "put", "skills/agent-team-design.md", "--body-file", libraryBodyFile],
        {
          apiBase,
          configPath,
          env,
        },
      ),
    ).rejects.toThrow("Agent Library file access is limited to docs/ paths");

    const updatedLibraryBodyFile = path.join(tempRoot, "agent-team-design-updated.md");
    const updatedLibraryBody = `${libraryBody}\n\nUpdated by agent CLI.`;
    writeFileSync(updatedLibraryBodyFile, updatedLibraryBody, "utf8");
    const updatedLibraryFile = await runCliJson<OrganizationWorkspaceFileDetail>(
      ["library", "file", "put", "docs/agent-team-design.md", "--body-file", updatedLibraryBodyFile],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(updatedLibraryFile.content).toBe(updatedLibraryBody);

    await expect(
      runCliJson<IssueComment>(["issue", "comment", fileIssueId, "--body", "inline"], {
        apiBase,
        configPath,
        env,
      }),
    ).rejects.toThrow("unknown option '--body'");
    await expect(
      runCliJson<Issue & { comment?: IssueComment | null }>(
        ["issue", "update", updateIssueId, "--comment", "inline"],
        {
          apiBase,
          configPath,
          env,
        },
      ),
    ).rejects.toThrow("unknown option '--comment'");
    await expect(
      runCliJson<Issue & { comment?: IssueComment | null }>(
        ["issue", "done", fileIssueId, "--comment", "inline"],
        {
          apiBase,
          configPath,
          env,
        },
      ),
    ).rejects.toThrow("unknown option '--comment'");
    await expect(
      runCliJson<Issue & { comment?: IssueComment | null }>(
        ["issue", "block", blockIssueId, "--comment", "inline"],
        {
          apiBase,
          configPath,
          env,
        },
      ),
    ).rejects.toThrow("unknown option '--comment'");
    await expect(
      runCliJson<Issue & { comment?: IssueComment | null }>(
        ["issue", "review", reviewIssueId, "--decision", "approve", "--comment", "inline"],
        {
          apiBase,
          configPath,
          env,
        },
      ),
    ).rejects.toThrow("unknown option '--comment'");
    await expect(
      runCliJson<IssueDocument>(["issue", "documents", "put", fileIssueId, "plan", "--body", "inline"], {
        apiBase,
        configPath,
        env,
      }),
    ).rejects.toThrow("unknown option '--body'");
  });

  it("uploads images for generic update comments", { timeout: 60_000 }, async () => {
    const db = createDb(connectionString);
    const updateIssueId = randomUUID();
    await db.insert(issues).values({
      id: updateIssueId,
      orgId,
      title: "Update with uploaded image",
      description: "Validate CLI image uploads into update comments.",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      createdByUserId: "local-board",
    });

    const env = {
      RUDDER_API_KEY: agentKey,
      RUDDER_ORG_ID: orgId,
      RUDDER_AGENT_ID: agentId,
      RUDDER_RUN_ID: runId,
    };
    await runCliJson<Issue>(["issue", "checkout", updateIssueId], {
      apiBase,
      configPath,
      env,
    });

    const imagePath = path.join(tempRoot, "update-proof.png");
    writeFileSync(imagePath, Buffer.from(tinyPngBase64, "base64"));

    const updateImageCommentFile = path.join(tempRoot, "update-image-comment.md");
    writeFileSync(updateImageCommentFile, "Update with image.", "utf8");
    const updated = await runCliJson<Issue & { comment?: IssueComment | null }>(
      ["issue", "update", updateIssueId, "--comment-file", updateImageCommentFile, "--image", imagePath],
      {
        apiBase,
        configPath,
        env,
      },
    );

    expect(updated.status).toBe("in_progress");
    expect(updated.comment?.body).toContain("Update with image.");
    expect(updated.comment?.body).toContain("![update-proof.png](/api/attachments/");

    const attachments = await db
      .select()
      .from(issueAttachments)
      .where(eq(issueAttachments.issueId, updateIssueId));
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.usage).toBe("comment_inline");
  });

  it("uploads images for close-out comments", { timeout: 60_000 }, async () => {
    const db = createDb(connectionString);
    const closeoutIssueId = randomUUID();
    await db.insert(issues).values({
      id: closeoutIssueId,
      orgId,
      title: "Close out with uploaded image",
      description: "Validate CLI image uploads into done comments.",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      createdByUserId: "local-board",
    });

    const env = {
      RUDDER_API_KEY: agentKey,
      RUDDER_ORG_ID: orgId,
      RUDDER_AGENT_ID: agentId,
      RUDDER_RUN_ID: runId,
    };
    await runCliJson<Issue>(["issue", "checkout", closeoutIssueId], {
      apiBase,
      configPath,
      env,
    });

    const imagePath = path.join(tempRoot, "done-proof.png");
    writeFileSync(imagePath, Buffer.from(tinyPngBase64, "base64"));

    const doneImageCommentFile = path.join(tempRoot, "done-image-comment.md");
    writeFileSync(doneImageCommentFile, "Done with image.", "utf8");
    const done = await runCliJson<Issue & { comment?: IssueComment | null }>(
      ["issue", "done", closeoutIssueId, "--comment-file", doneImageCommentFile, "--image", imagePath],
      {
        apiBase,
        configPath,
        env,
      },
    );

    expect(done.status).toBe("done");
    expect(done.comment?.body).toContain("Done with image.");
    expect(done.comment?.body).toContain("![done-proof.png](/api/attachments/");

    const attachments = await db
      .select()
      .from(issueAttachments)
      .where(eq(issueAttachments.issueId, closeoutIssueId));
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.usage).toBe("comment_inline");

    const blockIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockIssueId,
      orgId,
      title: "Block with uploaded image",
      description: "Validate CLI image uploads into blocker comments.",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      createdByUserId: "local-board",
    });
    await runCliJson<Issue>(["issue", "checkout", blockIssueId], {
      apiBase,
      configPath,
      env,
    });

    const blockImagePath = path.join(tempRoot, "block-proof.png");
    writeFileSync(blockImagePath, Buffer.from(tinyPngBase64, "base64"));

    const blockImageCommentFile = path.join(tempRoot, "block-image-comment.md");
    writeFileSync(blockImageCommentFile, "Blocked with image.", "utf8");
    const blocked = await runCliJson<Issue & { comment?: IssueComment | null }>(
      ["issue", "block", blockIssueId, "--comment-file", blockImageCommentFile, "--image", blockImagePath],
      {
        apiBase,
        configPath,
        env,
      },
    );

    expect(blocked.status).toBe("blocked");
    expect(blocked.comment?.body).toContain("Blocked with image.");
    expect(blocked.comment?.body).toContain("![block-proof.png](/api/attachments/");

    const blockAttachments = await db
      .select()
      .from(issueAttachments)
      .where(eq(issueAttachments.issueId, blockIssueId));
    expect(blockAttachments).toHaveLength(1);
    expect(blockAttachments[0]?.usage).toBe("comment_inline");
  });

  it("runs the CLI-only organization skill path", { timeout: 60_000 }, async () => {
    const env = {
      RUDDER_API_KEY: agentKey,
      RUDDER_ORG_ID: orgId,
      RUDDER_AGENT_ID: agentId,
      RUDDER_RUN_ID: runId,
    };

    const scan = await runCliJson<OrganizationSkillLocalScanResult>(
      ["skill", "scan-local", "--roots", localSkillRoot],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(scan.imported).toHaveLength(1);

    const privateSkill = await runCliJson<{
      created: AgentSkillEntry;
      enabledSnapshot: AgentSkillSnapshot | null;
    }>(
      [
        "agent",
        "skills",
        "create",
        "--name",
        "CLI Private Skill",
        "--slug",
        "cli-private-skill",
        "--description",
        "Private skill created by the agent CLI e2e regression.",
        "--enable",
      ],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(privateSkill.created.selectionKey).toBe("agent:cli-private-skill");
    expect(privateSkill.created.sourceClass).toBe("agent_home");
    expect(privateSkill.enabledSnapshot?.desiredSkills).toContain(privateSkill.created.selectionKey);

    const skills = await runCliJson<OrganizationSkillListItem[]>(["skill", "list"], {
      apiBase,
      configPath,
      env,
    });
    const importedSkill = skills.find((entry) => entry.slug === "cli-e2e-skill");
    expect(importedSkill).toBeTruthy();

    const detail = await runCliJson<OrganizationSkillDetail>(["skill", "get", importedSkill!.id], {
      apiBase,
      configPath,
      env,
    });
    expect(detail.id).toBe(importedSkill!.id);
    expect(detail.key).toBe(importedSkill!.key);

    const skillFile = await runCliJson<OrganizationSkillFileDetail>(["skill", "file", importedSkill!.id], {
      apiBase,
      configPath,
      env,
    });
    expect(skillFile.content).toContain("# CLI E2E Skill");

    const snapshot = await runCliJson<AgentSkillSnapshot>(
      ["agent", "skills", "sync", agentId, "--desired-skills", importedSkill!.key],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(snapshot.desiredSkills).toHaveLength(1);
    expect(
      snapshot.entries.some(
        (entry) =>
          (
            entry.key === importedSkill!.key
            || entry.selectionKey === importedSkill!.key
            || entry.sourcePath?.includes("/cli-e2e-skill") === true
          )
          && entry.desired,
      ),
    ).toBe(true);

    const additiveSnapshot = await runCliJson<AgentSkillSnapshot>(
      ["agent", "skills", "enable", agentId, importedSkill!.key],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(additiveSnapshot.desiredSkills).toEqual(snapshot.desiredSkills);
  });

  it("runs the CLI-only create-agent path", { timeout: 60_000 }, async () => {
    const env = {
      RUDDER_API_KEY: agentKey,
      RUDDER_ORG_ID: orgId,
      RUDDER_AGENT_ID: agentId,
      RUDDER_RUN_ID: runId,
    };

    const configIndex = await runCliJson<string>(["agent", "config", "index"], {
      apiBase,
      configPath,
      env,
    });
    expect(configIndex).toContain("# Rudder Agent Configuration Index");

    const codexDoc = await runCliJson<string>(["agent", "config", "doc", "codex_local"], {
      apiBase,
      configPath,
      env,
    });
    expect(codexDoc).toContain("# codex_local agent configuration");

    const icons = await runCliJson<string>(["agent", "icons"], {
      apiBase,
      configPath,
      env,
    });
    expect(icons).toContain("- crown");

    const agentRow = await runCliJson<AgentDetail>(["agent", "get", "cli-ceo"], {
      apiBase,
      configPath,
      env,
    });
    expect(agentRow.id).toBe(agentId);

    const configs = await runCliJson<AgentConfigurationSnapshot[]>(
      ["agent", "config", "list"],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(configs.some((row) => row.id === agentId)).toBe(true);

    const ownConfig = await runCliJson<AgentConfigurationSnapshot>(["agent", "config", "get", "cli-ceo"], {
      apiBase,
      configPath,
      env,
    });
    expect(ownConfig.id).toBe(agentId);
    expect(ownConfig.agentRuntimeType).toBe("codex_local");

    const directHire = await runCliJson<AgentHireResult>(
      [
        "agent",
        "hire",
        "--payload",
        JSON.stringify({
          name: "CLI Operator",
          role: "general",
          title: "CLI Operator",
          icon: "crown",
          reportsTo: agentId,
          capabilities: "Handles operational follow-through",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: { cwd: tempRoot, model: "o4-mini" },
          runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300, wakeOnDemand: true } },
          sourceIssueId: issueId,
        }),
      ],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(directHire.approval).toBeNull();
    expect(directHire.agent.status).toBe("idle");

    const db = createDb(connectionString);
    await db.update(organizations).set({ requireBoardApprovalForNewAgents: true }).where(eq(organizations.id, orgId));

    const approvalHire = await runCliJson<AgentHireResult>(
      [
        "agent",
        "hire",
        "--payload",
        JSON.stringify({
          name: "CLI Reviewer",
          role: "general",
          title: "CLI Reviewer",
          icon: "crown",
          reportsTo: agentId,
          capabilities: "Reviews execution quality",
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: { cwd: tempRoot, model: "o4-mini" },
          runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300, wakeOnDemand: true } },
          sourceIssueIds: [issueId],
        }),
      ],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(approvalHire.agent.status).toBe("pending_approval");
    expect(approvalHire.approval?.type).toBe("hire_agent");

    const approval = await runCliJson<Approval>(["approval", "get", approvalHire.approval!.id], {
      apiBase,
      configPath,
      env,
    });
    expect(approval.id).toBe(approvalHire.approval!.id);
    expect(approval.status).toBe("pending");

    const approvalIssues = await runCliJson<Issue[]>(["approval", "issues", approvalHire.approval!.id], {
      apiBase,
      configPath,
      env,
    });
    expect(approvalIssues.some((row) => row.id === issueId)).toBe(true);

    const approvalCommentFile = path.join(tempRoot, "approval-comment.md");
    writeFileSync(approvalCommentFile, "## Update\n\nWaiting on board review.", "utf8");
    const comment = await runCliJson<ApprovalComment>(
      ["approval", "comment", approvalHire.approval!.id, "--body-file", approvalCommentFile],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(comment.body).toContain("Waiting on board review");
    const stdinComment = await runCliJson<ApprovalComment>(
      ["approval", "comment", approvalHire.approval!.id, "--body-file", "-"],
      {
        apiBase,
        configPath,
        env,
        stdin: "## Stdin update\n\nApproval comment from stdin.",
      },
    );
    expect(stdinComment.body).toContain("Approval comment from stdin");
    await expect(
      runCliJson<ApprovalComment>(["approval", "comment", approvalHire.approval!.id, "--body", "inline"], {
        apiBase,
        configPath,
        env,
      }),
    ).rejects.toThrow("unknown option '--body'");
  });
});
