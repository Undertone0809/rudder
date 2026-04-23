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
  createDb,
  ensurePostgresDatabase,
  issueComments,
  issues,
  organizations,
} from "@rudder/db";
import type {
  AgentDetail,
  AgentSkillSnapshot,
  Approval,
  ApprovalComment,
  Issue,
  IssueComment,
  OrganizationSkillDetail,
  OrganizationSkillFileDetail,
  OrganizationSkillListItem,
  OrganizationSkillLocalScanResult,
} from "@rudder/shared";

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
        stdio: ["ignore", "pipe", "pipe"],
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
        default_chat_issue_creation_mode,
        default_chat_agent_runtime_type,
        default_chat_agent_runtime_config
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
        ${"manual_approval"},
        ${null},
        ${null}
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
      permissions: { canCreateAgents: true },
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

    const done = await runCliJson<Issue>(["issue", "done", issueId, "--comment", "Completed via CLI."], {
      apiBase,
      configPath,
      env,
    });
    expect(done.status).toBe("done");
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

    const comment = await runCliJson<ApprovalComment>(
      ["approval", "comment", approvalHire.approval!.id, "--body", "## Update\n\nWaiting on board review."],
      {
        apiBase,
        configPath,
        env,
      },
    );
    expect(comment.body).toContain("Waiting on board review");
  });
});
