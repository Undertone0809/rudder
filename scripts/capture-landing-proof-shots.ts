import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { chromium, expect, request, type APIRequestContext, type APIResponse, type Locator, type Page } from "@playwright/test";
import {
  activityLog,
  agentTaskSessions,
  approvals,
  chatConversations,
  costEvents,
  createDb,
  financeEvents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "../packages/db/src/index.ts";

const REPO_ROOT = process.cwd();
const OUTPUT_ROOT = "/tmp/rudder-landing-proof-shots";
const INSTANCE_ID = "landing-shots";
const SERVER_HOST = "localhost";
const DATABASE_HOST = "127.0.0.1";
const HOME_DIR = path.join(OUTPUT_ROOT, "home");
const INSTANCE_ROOT = path.join(HOME_DIR, "instances", INSTANCE_ID);
const CONFIG_PATH = path.join(INSTANCE_ROOT, "config.json");
const BIN_DIR = path.join(OUTPUT_ROOT, "bin");
const CHAT_STUB_PATH = path.join(BIN_DIR, "landing-chat-stub.js");
const AGENT_STUB_PATH = path.join(BIN_DIR, "landing-agent-stub.js");
const SERVER_LOG_PATH = path.join(OUTPUT_ROOT, "server.log");
const SHOTS_DIR = path.join(OUTPUT_ROOT, "shots");
const PATH_PREFIX = `/opt/homebrew/bin:${process.env.PATH ?? ""}`;
const require = createRequire(import.meta.url);
const {
  and,
  desc,
  eq,
  inArray,
} = require(require.resolve("drizzle-orm", { paths: [path.join(REPO_ROOT, "packages/db")] })) as typeof import("drizzle-orm");

type SeedContext = {
  org: { id: string; issuePrefix: string };
  projects: Record<string, { id: string; name: string }>;
  agents: Record<string, { id: string; name: string }>;
  issues: Record<string, { id: string; identifier: string | null; title: string }>;
  approvals: Record<string, { id: string }>;
  chats: Record<string, { id: string }>;
};

const SKIP_CAPTURE = process.env.LANDING_SHOTS_SKIP_CAPTURE === "1";
const HOLD_OPEN = process.env.LANDING_SHOTS_HOLD_OPEN === "1";

function isoAt(base: Date, offsetHours: number) {
  return new Date(base.getTime() + offsetHours * 60 * 60 * 1000).toISOString();
}

function orgRoute(orgPrefix: string, pathname: string) {
  const normalizedPrefix = orgPrefix.replace(/^\/+|\/+$/g, "");
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `/${normalizedPrefix}${normalizedPath}`;
}

async function ensureEmptyDir(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function writeCaptureConfig() {
  const config = {
    $meta: {
      version: 1,
      updatedAt: "2026-04-22T00:00:00.000Z",
      source: "landing-proof-shots-maintainer",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(INSTANCE_ROOT, "db"),
      embeddedPostgresPort: 54339,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(INSTANCE_ROOT, "data", "backups"),
      },
    },
    logging: {
      mode: "file",
      logDir: path.join(INSTANCE_ROOT, "logs"),
    },
    server: {
      deploymentMode: "local_trusted",
      host: SERVER_HOST,
      port: 3290,
    },
    auth: { baseUrlMode: "auto" },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: path.join(INSTANCE_ROOT, "data", "storage"),
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: path.join(INSTANCE_ROOT, "secrets", "master.key"),
      },
    },
  };
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

async function writeChatStub() {
  await fs.mkdir(BIN_DIR, { recursive: true });
  const source = `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", async () => {
  const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const result = {
    kind: "issue_proposal",
    body: "I drafted a launch-scoped issue from this request. Review it here before creating the durable issue.",
    structuredPayload: {
      issueProposal: {
        title: "Ship enterprise pricing comparison page",
        description: [
          "Build the public enterprise pricing comparison page before Friday.",
          "",
          "Scope:",
          "- compare Rudder against two alternatives",
          "- add two customer proof points",
          "- draft the public beta CTA",
          "- keep approval language aligned with launch review flow"
        ].join("\\n"),
        priority: "high"
      }
    }
  };
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "landing-thread", model: "gpt-5.4" }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: result.body + "\\n" + sentinel + JSON.stringify(result),
    },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 240 },
  }) + "\\n");
});
`;
  await fs.writeFile(CHAT_STUB_PATH, source, "utf8");
  await fs.chmod(CHAT_STUB_PATH, 0o755);

  const agentSource = `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", async () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "landing-agent-thread", model: "gpt-5.4" }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: {
      id: "msg-1",
      type: "agent_message",
      text: "Completed the requested launch task and synced progress back to Rudder.",
    },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "turn.completed",
    result: "Completed the requested launch task and synced progress back to Rudder.",
    usage: { input_tokens: 48, cached_input_tokens: 0, output_tokens: 96 },
  }) + "\\n");
});
`;
  await fs.writeFile(AGENT_STUB_PATH, agentSource, "utf8");
  await fs.chmod(AGENT_STUB_PATH, 0o755);
}

async function waitForServer(baseUrl: string) {
  const api = await request.newContext({ baseURL: baseUrl });
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const res = await api.get("/api/health");
        if (res.ok()) return;
      } catch {
        // retry
      }
      await delay(1000);
    }
  } finally {
    await api.dispose();
  }
  throw new Error(`Timed out waiting for ${baseUrl}/api/health`);
}

async function resolveRuntimeInfo() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const log = await fs.readFile(SERVER_LOG_PATH, "utf8").catch(() => "");
    const serverPort = log.match(/API\s+http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/api/)?.[1]
      ?? log.match(/Server listening on (?:127\.0\.0\.1|localhost):(\d+)/)?.[1];
    const dbPort = log.match(/\(pg:(\d+)\)/)?.[1]
      ?? log.match(/embedded PostgreSQL.*port=(\d+)/)?.[1];
    if (serverPort && dbPort) {
      const baseUrl = `http://${SERVER_HOST}:${serverPort}`;
      await waitForServer(baseUrl);
      return {
        baseUrl,
        dbUrl: `postgres://rudder:rudder@${DATABASE_HOST}:${dbPort}/rudder`,
      };
    }
    await delay(1000);
  }
  throw new Error("Timed out resolving server/database runtime info from startup log");
}

async function startServer() {
  await fs.writeFile(SERVER_LOG_PATH, "", "utf8");
  const child = spawn(
    "/opt/homebrew/bin/npx",
    ["pnpm", "--filter", "@rudderhq/server", "dev"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: PATH_PREFIX,
        RUDDER_HOME: HOME_DIR,
        RUDDER_INSTANCE_ID: INSTANCE_ID,
        RUDDER_UI_DEV_MIDDLEWARE: "true",
        LANGFUSE_ENABLED: "false",
      },
      stdio: "pipe",
    },
  );
  child.stdout.on("data", async (chunk) => {
    await fs.appendFile(SERVER_LOG_PATH, chunk);
  });
  child.stderr.on("data", async (chunk) => {
    await fs.appendFile(SERVER_LOG_PATH, chunk);
  });
  return child;
}

async function stopServer(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(10_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }),
  ]);
}

async function apiJson<T>(res: APIResponse) {
  if (!res.ok()) {
    throw new Error(`API request failed: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function createOrganization(api: APIRequestContext) {
  return apiJson<{ id: string; issuePrefix: string }>(
    await api.post("/api/orgs", {
      data: {
        name: "Rudder",
        description: "Launch-week demo org for landing proof shots.",
        budgetMonthlyCents: 500000,
        defaultChatIssueCreationMode: "manual_approval",
        defaultChatAgentRuntimeType: "codex_local",
        defaultChatAgentRuntimeConfig: {
          model: "gpt-5.4",
          command: CHAT_STUB_PATH,
        },
      },
    }),
  );
}

async function createGoal(api: APIRequestContext, orgId: string) {
  return apiJson<{ id: string }>(
    await api.post(`/api/orgs/${orgId}/goals`, {
      data: {
        title: "Ship the desktop-first public beta and supporting launch assets",
        level: "organization",
        status: "active",
      },
    }),
  );
}

async function createProject(
  api: APIRequestContext,
  orgId: string,
  input: {
    goalId: string;
    name: string;
    description: string;
    status: string;
    color?: string;
  },
) {
  return apiJson<{ id: string; name: string }>(
    await api.post(`/api/orgs/${orgId}/projects`, {
      data: {
        name: input.name,
        description: input.description,
        status: input.status,
        goalId: input.goalId,
        color: input.color,
      },
    }),
  );
}

async function createLabel(api: APIRequestContext, orgId: string, name: string, color: string) {
  return apiJson<{ id: string }>(
    await api.post(`/api/orgs/${orgId}/labels`, { data: { name, color } }),
  );
}

async function createAgent(
  api: APIRequestContext,
  orgId: string,
  input: {
    name: string;
    role: string;
    title: string;
    reportsTo?: string | null;
    capabilities: string;
    status: string;
    intervalSec: number;
    budgetMonthlyCents: number;
  },
) {
  const created = await apiJson<{ id: string; name: string }>(
    await api.post(`/api/orgs/${orgId}/agents`, {
      data: {
        name: input.name,
        role: input.role,
        title: input.title,
        reportsTo: input.reportsTo ?? null,
        capabilities: input.capabilities,
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: AGENT_STUB_PATH,
        },
        budgetMonthlyCents: input.budgetMonthlyCents,
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: input.intervalSec,
          },
        },
      },
    }),
  );
  await apiJson(
    await api.patch(`/api/agents/${created.id}?orgId=${encodeURIComponent(orgId)}`, {
      data: {
        status: input.status,
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: AGENT_STUB_PATH,
        },
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: input.intervalSec,
          },
        },
      },
    }),
  );
  return created;
}

async function createIssue(
  api: APIRequestContext,
  orgId: string,
  data: Record<string, unknown>,
) {
  return apiJson<{ id: string; identifier: string | null; title: string }>(
    await api.post(`/api/orgs/${orgId}/issues`, { data }),
  );
}

async function createApproval(api: APIRequestContext, orgId: string, data: Record<string, unknown>) {
  return apiJson<{ id: string }>(
    await api.post(`/api/orgs/${orgId}/approvals`, { data }),
  );
}

async function createChat(api: APIRequestContext, orgId: string) {
  return apiJson<{ id: string }>(
    await api.post(`/api/orgs/${orgId}/chats`, {
      data: {
        title: "Launch intake",
        summary: "Clarify launch requests, draft issue proposals, and keep the work trail attached to the resulting issue.",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    }),
  );
}

async function reportCostEvent(
  api: APIRequestContext,
  orgId: string,
  data: Record<string, unknown>,
) {
  return apiJson(await api.post(`/api/orgs/${orgId}/cost-events`, { data }));
}

async function reportFinanceEvent(
  api: APIRequestContext,
  orgId: string,
  data: Record<string, unknown>,
) {
  return apiJson(await api.post(`/api/orgs/${orgId}/finance-events`, { data }));
}

async function upsertBudgetPolicy(
  api: APIRequestContext,
  orgId: string,
  data: Record<string, unknown>,
) {
  return apiJson(await api.post(`/api/orgs/${orgId}/budgets/policies`, { data }));
}

async function seedDemoOrg(api: APIRequestContext, dbUrl: string): Promise<SeedContext> {
  const org = await createOrganization(api);
  const goal = await createGoal(api, org.id);
  const projects = {
    launch: await createProject(api, org.id, {
      goalId: goal.id,
      name: "public-beta-launch",
      description: "Cross-functional launch work for the desktop-first public beta.",
      status: "in_progress",
      color: "#2563eb",
    }),
    desktopReliability: await createProject(api, org.id, {
      goalId: goal.id,
      name: "desktop-reliability",
      description: "Reliability fixes for packaged app startup, migrations, and crash recovery.",
      status: "in_progress",
      color: "#dc2626",
    }),
    onboardingActivation: await createProject(api, org.id, {
      goalId: goal.id,
      name: "onboarding-activation",
      description: "Shorten time-to-first-success for new desktop users and admins.",
      status: "planned",
      color: "#0891b2",
    }),
    enterpriseReadiness: await createProject(api, org.id, {
      goalId: goal.id,
      name: "enterprise-readiness",
      description: "Approval flows, audit surfaces, and enterprise-facing operator trust work.",
      status: "in_progress",
      color: "#7c3aed",
    }),
    releaseOperations: await createProject(api, org.id, {
      goalId: goal.id,
      name: "release-operations",
      description: "Release train health, smoke checks, and launch-week operational readiness.",
      status: "in_progress",
      color: "#ea580c",
    }),
    messengerExperience: await createProject(api, org.id, {
      goalId: goal.id,
      name: "messenger-experience",
      description: "Improve chat, approval, and run-summary clarity for operators.",
      status: "backlog",
      color: "#0f766e",
    }),
  };

  const labelIds = {
    launch: (await createLabel(api, org.id, "launch", "#0f766e")).id,
    website: (await createLabel(api, org.id, "website", "#2563eb")).id,
    desktop: (await createLabel(api, org.id, "desktop", "#dc2626")).id,
    enterprise: (await createLabel(api, org.id, "enterprise", "#7c3aed")).id,
    ops: (await createLabel(api, org.id, "ops", "#ea580c")).id,
    messenger: (await createLabel(api, org.id, "messenger", "#0891b2")).id,
  };

  const ceo = await createAgent(api, org.id, {
    name: "CEO",
    role: "ceo",
    title: "CEO",
    capabilities: "Own the launch plan, review metrics, and escalate approvals that block public beta progress.",
    status: "running",
    intervalSec: 21600,
    budgetMonthlyCents: 150000,
  });
  const foundingEngineer = await createAgent(api, org.id, {
    name: "Founding Engineer",
    role: "engineer",
    title: "Founding Engineer",
    reportsTo: ceo.id,
    capabilities: "Own core desktop reliability, implementation delivery, and issue execution for product-critical work.",
    status: "active",
    intervalSec: 1800,
    budgetMonthlyCents: 120000,
  });
  const designEngineer = await createAgent(api, org.id, {
    name: "Design Engineer",
    role: "designer",
    title: "Design Engineer",
    reportsTo: foundingEngineer.id,
    capabilities: "Refine product hierarchy, launch surfaces, and visual consistency across the desktop workflow.",
    status: "active",
    intervalSec: 7200,
    budgetMonthlyCents: 80000,
  });
  const releaseEngineer = await createAgent(api, org.id, {
    name: "Release Engineer",
    role: "devops",
    title: "Release Engineer",
    reportsTo: foundingEngineer.id,
    capabilities: "Package builds, run smoke checks, and keep the beta release train healthy.",
    status: "active",
    intervalSec: 14400,
    budgetMonthlyCents: 90000,
  });
  const growthLead = await createAgent(api, org.id, {
    name: "Growth Lead",
    role: "general",
    title: "Growth Lead",
    reportsTo: ceo.id,
    capabilities: "Own launch messaging, landing copy, pricing narrative, and beta funnel work.",
    status: "idle",
    intervalSec: 0,
    budgetMonthlyCents: 70000,
  });
  const supportOps = await createAgent(api, org.id, {
    name: "Support Ops",
    role: "general",
    title: "Support Ops",
    reportsTo: growthLead.id,
    capabilities: "Handle onboarding feedback, support issue triage, and close the loop on launch blockers.",
    status: "paused",
    intervalSec: 3600,
    budgetMonthlyCents: 40000,
  });

  const mainIssue = await createIssue(api, org.id, {
    projectId: projects.launch.id,
    goalId: goal.id,
    title: "Ship enterprise pricing comparison page",
    description: "Create the pricing comparison page for launch, including competitor callouts, customer proof, and public beta CTA.",
    status: "in_review",
    priority: "high",
    assigneeAgentId: growthLead.id,
    labelIds: [labelIds.launch, labelIds.website],
  });
  const crashIssue = await createIssue(api, org.id, {
    projectId: projects.desktopReliability.id,
    goalId: goal.id,
    title: "Fix desktop startup crash on macOS 15",
    description: "Investigate and resolve the startup crash seen in packaged desktop builds.",
    status: "done",
    priority: "critical",
    assigneeAgentId: foundingEngineer.id,
    labelIds: [labelIds.launch, labelIds.desktop],
  });
  const briefIssue = await createIssue(api, org.id, {
    projectId: projects.launch.id,
    goalId: goal.id,
    title: "Draft launch brief for public beta",
    description: "Assemble launch narrative, rollout checklist, and success metrics for the public beta push.",
    status: "done",
    priority: "high",
    assigneeAgentId: growthLead.id,
    labelIds: [labelIds.launch],
  });
  const onboardingIssue = await createIssue(api, org.id, {
    projectId: projects.onboardingActivation.id,
    goalId: goal.id,
    title: "Publish onboarding checklist for new desktop users",
    description: "Ship a concise checklist for first-run setup, permissions, and common failure modes.",
    status: "todo",
    priority: "medium",
    assigneeAgentId: supportOps.id,
    labelIds: [labelIds.launch, labelIds.desktop],
  });
  const approvalCopyIssue = await createIssue(api, org.id, {
    projectId: projects.enterpriseReadiness.id,
    goalId: goal.id,
    title: "Tighten approval copy for release-blocking changes",
    description: "Make approval prompts more explicit for public-facing changes and launch-sensitive actions.",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: designEngineer.id,
    labelIds: [labelIds.launch, labelIds.enterprise],
  });
  const transcriptIssue = await createIssue(api, org.id, {
    projectId: projects.messengerExperience.id,
    goalId: goal.id,
    title: "Reduce run transcript noise in Messenger",
    description: "Improve run summaries in Messenger so operators can see the decision boundary faster.",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: designEngineer.id,
    labelIds: [labelIds.launch, labelIds.messenger],
  });
  const hiringIssue = await createIssue(api, org.id, {
    projectId: projects.releaseOperations.id,
    goalId: goal.id,
    title: "Review launch-week support staffing",
    description: "Validate launch-week support coverage and role boundaries before public beta.",
    status: "blocked",
    priority: "medium",
    assigneeAgentId: ceo.id,
    labelIds: [labelIds.launch, labelIds.ops],
  });
  const homepageIssue = await createIssue(api, org.id, {
    projectId: projects.launch.id,
    goalId: goal.id,
    title: "Refresh homepage CTA for desktop-first beta",
    description: "Align the homepage CTA, subcopy, and credibility proof with the desktop-first beta launch.",
    status: "in_progress",
    priority: "high",
    assigneeAgentId: growthLead.id,
    labelIds: [labelIds.launch, labelIds.website],
  });
  const faqIssue = await createIssue(api, org.id, {
    projectId: projects.launch.id,
    goalId: goal.id,
    title: "Publish launch FAQ for pricing and rollout questions",
    description: "Answer pricing, deployment mode, and operator workflow questions before beta traffic lands.",
    status: "todo",
    priority: "medium",
    assigneeAgentId: growthLead.id,
    labelIds: [labelIds.launch, labelIds.website],
  });
  const profileMigrationIssue = await createIssue(api, org.id, {
    projectId: projects.desktopReliability.id,
    goalId: goal.id,
    title: "Harden profile migration after installer upgrade",
    description: "Prevent stale profile state from breaking packaged app startup after upgrades.",
    status: "in_review",
    priority: "high",
    assigneeAgentId: foundingEngineer.id,
    labelIds: [labelIds.desktop, labelIds.ops],
  });
  const crashTelemetryIssue = await createIssue(api, org.id, {
    projectId: projects.desktopReliability.id,
    goalId: goal.id,
    title: "Add startup crash telemetry breadcrumbs",
    description: "Capture startup stage breadcrumbs so packaged crash reports show the failing subsystem immediately.",
    status: "todo",
    priority: "medium",
    assigneeAgentId: foundingEngineer.id,
    labelIds: [labelIds.desktop, labelIds.ops],
  });
  const permissionsIssue = await createIssue(api, org.id, {
    projectId: projects.onboardingActivation.id,
    goalId: goal.id,
    title: "Guide first-run permission setup inside desktop shell",
    description: "Explain filesystem and automation permissions during first run without losing launch momentum.",
    status: "in_review",
    priority: "high",
    assigneeAgentId: supportOps.id,
    labelIds: [labelIds.desktop, labelIds.launch],
  });
  const importGuideIssue = await createIssue(api, org.id, {
    projectId: projects.onboardingActivation.id,
    goalId: goal.id,
    title: "Create import guide for teams moving from task boards",
    description: "Document how a new org can import existing project structure and issues into Rudder.",
    status: "todo",
    priority: "medium",
    assigneeAgentId: supportOps.id,
    labelIds: [labelIds.launch],
  });
  const auditIssue = await createIssue(api, org.id, {
    projectId: projects.enterpriseReadiness.id,
    goalId: goal.id,
    title: "Expose audit-ready export for approvals and issue decisions",
    description: "Make approvals, issue state changes, and comments exportable for enterprise review.",
    status: "todo",
    priority: "high",
    assigneeAgentId: designEngineer.id,
    labelIds: [labelIds.enterprise, labelIds.ops],
  });
  const soc2Issue = await createIssue(api, org.id, {
    projectId: projects.enterpriseReadiness.id,
    goalId: goal.id,
    title: "Map operator actions to SOC2 control evidence",
    description: "Show how approval, run history, and org controls map to common SOC2 evidence requests.",
    status: "backlog",
    priority: "medium",
    assigneeAgentId: ceo.id,
    labelIds: [labelIds.enterprise],
  });
  const releaseChecklistIssue = await createIssue(api, org.id, {
    projectId: projects.releaseOperations.id,
    goalId: goal.id,
    title: "Finalize public beta release checklist",
    description: "Consolidate packaging, smoke, rollback, and operator announcement checkpoints for beta release.",
    status: "done",
    priority: "high",
    assigneeAgentId: releaseEngineer.id,
    labelIds: [labelIds.launch, labelIds.ops],
  });
  const nightlySmokeIssue = await createIssue(api, org.id, {
    projectId: projects.releaseOperations.id,
    goalId: goal.id,
    title: "Triage nightly smoke failures before launch window",
    description: "Review nightly smoke failures and keep the beta release train green through launch week.",
    status: "in_progress",
    priority: "high",
    assigneeAgentId: releaseEngineer.id,
    labelIds: [labelIds.desktop, labelIds.ops],
  });
  const chatAutomationIssue = await createIssue(api, org.id, {
    projectId: projects.messengerExperience.id,
    goalId: goal.id,
    title: "Make chat-created issues feel durable, not disposable",
    description: "Improve proposal-to-issue transitions so chat remains a trustworthy intake surface for operators.",
    status: "todo",
    priority: "medium",
    assigneeAgentId: designEngineer.id,
    labelIds: [labelIds.messenger, labelIds.launch],
  });
  const approvalsInboxIssue = await createIssue(api, org.id, {
    projectId: projects.messengerExperience.id,
    goalId: goal.id,
    title: "Group related approvals into one operator inbox view",
    description: "Give operators a better approvals queue when multiple release-sensitive asks land at once.",
    status: "backlog",
    priority: "medium",
    assigneeAgentId: ceo.id,
    labelIds: [labelIds.messenger, labelIds.enterprise],
  });

  await apiJson(await api.put(`/api/issues/${mainIssue.id}/documents/plan`, {
    data: {
      title: "Launch plan",
      format: "markdown",
      body: [
        "## Outputs",
        "- Preview deployed: pricing-v4",
        "- PR #184 opened for CTA and comparison copy",
        "- docs/pricing-comparison.md updated",
        "",
        "## Remaining review",
        "- validate competitor claims",
        "- approve customer proof quotes",
      ].join("\n"),
    },
  }));
  await apiJson(await api.put(`/api/issues/${mainIssue.id}/documents/brief`, {
    data: {
      title: "Launch brief excerpt",
      format: "markdown",
      body: [
        "## Preview deployed",
        "pricing-v4",
        "",
        "## Key changes",
        "- Added competitor matrix",
        "- Added two customer proof points",
        "- Drafted desktop beta CTA",
      ].join("\n"),
    },
  }));

  const publishApproval = await createApproval(api, org.id, {
    type: "budget_override_required",
    payload: {
      scopeName: "Enterprise pricing page publish review",
      windowKind: "calendar_month_utc",
      metric: "cost_cents",
      budgetAmount: 45000,
      observedAmount: 51200,
      guidance: "Public-facing claims and customer quotes need board review before publish.",
    },
    issueIds: [mainIssue.id],
  });

  const staffingApproval = await createApproval(api, org.id, {
    type: "hire_agent",
    payload: {
      name: "Launch Support Engineer",
      role: "engineer",
      title: "Launch Support Engineer",
      capabilities: "Cover launch-week support escalations, triage onboarding blockers, and keep the beta queue moving.",
      desiredSkills: ["debug-run-transcript", "software-product-advisor"],
      agentRuntimeType: "codex_local",
    },
    issueIds: [hiringIssue.id],
  });

  const chat = await createChat(api, org.id);

  const db = createDb(dbUrl);
  const now = new Date("2026-04-22T10:00:00.000Z");

  const runRows = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.orgId, org.id));
  if (runRows.length > 0) {
    const runIds = runRows.map((row) => row.id);
    const runLinkedCostRows = await db
      .select({ id: costEvents.id })
      .from(costEvents)
      .where(inArray(costEvents.heartbeatRunId, runIds));

    if (runLinkedCostRows.length > 0) {
      await db.delete(financeEvents).where(inArray(financeEvents.costEventId, runLinkedCostRows.map((row) => row.id)));
    }
    await db.update(agentTaskSessions).set({ lastRunId: null }).where(inArray(agentTaskSessions.lastRunId, runIds));
    await db.delete(heartbeatRunEvents).where(inArray(heartbeatRunEvents.runId, runIds));
    await db.delete(activityLog).where(inArray(activityLog.runId, runIds));
    await db.delete(financeEvents).where(inArray(financeEvents.heartbeatRunId, runIds));
    await db.delete(costEvents).where(inArray(costEvents.heartbeatRunId, runIds));
    await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.id, runRows.map((row) => row.id)));
  }

  const insertedRuns = await db.insert(heartbeatRuns).values([
    {
      orgId: org.id,
      agentId: ceo.id,
      invocationSource: "scheduler",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(isoAt(now, -0.3)),
      resultJson: { summary: "Reviewing launch metrics and open approvals." },
      contextSnapshot: { issueId: hiringIssue.id },
      createdAt: new Date(isoAt(now, -0.3)),
      updatedAt: new Date(isoAt(now, -0.1)),
    },
    {
      orgId: org.id,
      agentId: foundingEngineer.id,
      invocationSource: "scheduler",
      triggerDetail: "system",
      status: "succeeded",
      startedAt: new Date(isoAt(now, -2.2)),
      finishedAt: new Date(isoAt(now, -2.0)),
      resultJson: { summary: "Fixed desktop startup crash on macOS 15 and pushed PR #184." },
      contextSnapshot: { issueId: crashIssue.id },
      createdAt: new Date(isoAt(now, -2.2)),
      updatedAt: new Date(isoAt(now, -2.0)),
    },
    {
      orgId: org.id,
      agentId: designEngineer.id,
      invocationSource: "scheduler",
      triggerDetail: "system",
      status: "succeeded",
      startedAt: new Date(isoAt(now, -5.0)),
      finishedAt: new Date(isoAt(now, -4.7)),
      resultJson: { summary: "Revised pricing page hierarchy and tightened approval copy." },
      contextSnapshot: { issueId: approvalCopyIssue.id },
      createdAt: new Date(isoAt(now, -5.0)),
      updatedAt: new Date(isoAt(now, -4.7)),
    },
    {
      orgId: org.id,
      agentId: releaseEngineer.id,
      invocationSource: "scheduler",
      triggerDetail: "system",
      status: "succeeded",
      startedAt: new Date(isoAt(now, -8.0)),
      finishedAt: new Date(isoAt(now, -7.6)),
      resultJson: { summary: "Packaged beta build and completed smoke checks." },
      contextSnapshot: { issueId: releaseChecklistIssue.id },
      createdAt: new Date(isoAt(now, -8.0)),
      updatedAt: new Date(isoAt(now, -7.6)),
    },
    {
      orgId: org.id,
      agentId: growthLead.id,
      invocationSource: "manual",
      triggerDetail: "manual",
      status: "succeeded",
      startedAt: new Date(isoAt(now, -18.0)),
      finishedAt: new Date(isoAt(now, -17.2)),
      resultJson: { summary: "Drafted beta launch brief and routed pricing page review." },
      contextSnapshot: { issueId: briefIssue.id },
      createdAt: new Date(isoAt(now, -18.0)),
      updatedAt: new Date(isoAt(now, -17.2)),
    },
  ]).returning({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId });

  const runByAgent = new Map(insertedRuns.map((row) => [row.agentId, row.id]));

  await db.insert(issueComments).values([
    {
      orgId: org.id,
      issueId: mainIssue.id,
      authorAgentId: growthLead.id,
      body: "Preview deployed: pricing-v4. Added competitor matrix, two customer proof points, and a draft public beta CTA.",
      createdAt: new Date(isoAt(now, -3.5)),
      updatedAt: new Date(isoAt(now, -3.5)),
    },
    {
      orgId: org.id,
      issueId: mainIssue.id,
      authorAgentId: designEngineer.id,
      body: "Tightened hierarchy and reduced above-the-fold copy density. Waiting on operator review for competitor claims and quote usage.",
      createdAt: new Date(isoAt(now, -2.8)),
      updatedAt: new Date(isoAt(now, -2.8)),
    },
  ]);

  await upsertBudgetPolicy(api, org.id, {
    scopeType: "agent",
    scopeId: growthLead.id,
    amount: 90000,
    windowKind: "calendar_month_utc",
  });

  await reportCostEvent(api, org.id, {
    agentId: foundingEngineer.id,
    issueId: crashIssue.id,
    projectId: projects.desktopReliability.id,
    goalId: goal.id,
    heartbeatRunId: runByAgent.get(foundingEngineer.id),
    provider: "openai",
    biller: "codex",
    billingType: "metered_api",
    model: "gpt-5.4",
    inputTokens: 182000,
    outputTokens: 64000,
    costCents: 6840,
    occurredAt: isoAt(now, -2.0),
  });
  await reportCostEvent(api, org.id, {
    agentId: growthLead.id,
    issueId: mainIssue.id,
    projectId: projects.launch.id,
    goalId: goal.id,
    heartbeatRunId: runByAgent.get(growthLead.id),
    provider: "anthropic",
    biller: "claude",
    billingType: "metered_api",
    model: "claude-sonnet-4.5",
    inputTokens: 214000,
    outputTokens: 51000,
    costCents: 9520,
    occurredAt: isoAt(now, -17.2),
  });
  await reportCostEvent(api, org.id, {
    agentId: designEngineer.id,
    issueId: transcriptIssue.id,
    projectId: projects.messengerExperience.id,
    goalId: goal.id,
    heartbeatRunId: runByAgent.get(designEngineer.id),
    provider: "google",
    biller: "gemini",
    billingType: "metered_api",
    model: "gemini-2.5-pro",
    inputTokens: 91000,
    outputTokens: 22000,
    costCents: 3310,
    occurredAt: isoAt(now, -4.7),
  });
  await reportCostEvent(api, org.id, {
    agentId: releaseEngineer.id,
    issueId: releaseChecklistIssue.id,
    projectId: projects.releaseOperations.id,
    goalId: goal.id,
    heartbeatRunId: runByAgent.get(releaseEngineer.id),
    provider: "openai",
    biller: "codex",
    billingType: "metered_api",
    model: "gpt-5.4-mini",
    inputTokens: 42000,
    outputTokens: 9000,
    costCents: 1180,
    occurredAt: isoAt(now, -7.6),
  });

  const latestCostRows = await db
    .select({ id: costEvents.id })
    .from(costEvents)
    .where(eq(costEvents.orgId, org.id))
    .orderBy(desc(costEvents.createdAt));

  if (latestCostRows[0]) {
    await reportFinanceEvent(api, org.id, {
      costEventId: latestCostRows[0].id,
      eventKind: "inference_charge",
      direction: "debit",
      biller: "OpenAI",
      provider: "openai",
      executionAgentRuntimeType: "codex_local",
      model: "gpt-5.4-mini",
      amountCents: 1180,
      description: "Release smoke-check runtime usage",
      occurredAt: isoAt(now, -7.6),
    });
  }
  await reportFinanceEvent(api, org.id, {
    eventKind: "platform_fee",
    direction: "debit",
    biller: "Anthropic",
    provider: "anthropic",
    amountCents: 2400,
    description: "Monthly priority lane fee",
    occurredAt: isoAt(now, -20.0),
  });

  const issueSchedule = [
    { issueId: briefIssue.id, offsetHours: -20.0 },
    { issueId: crashIssue.id, offsetHours: -19.0 },
    { issueId: mainIssue.id, offsetHours: -18.0 },
    { issueId: homepageIssue.id, offsetHours: -17.0 },
    { issueId: faqIssue.id, offsetHours: -16.0 },
    { issueId: profileMigrationIssue.id, offsetHours: -15.0 },
    { issueId: releaseChecklistIssue.id, offsetHours: -14.0 },
    { issueId: auditIssue.id, offsetHours: -13.0 },
    { issueId: soc2Issue.id, offsetHours: -12.0 },
    { issueId: transcriptIssue.id, offsetHours: -10.0 },
    { issueId: chatAutomationIssue.id, offsetHours: -9.0 },
    { issueId: nightlySmokeIssue.id, offsetHours: -8.0 },
    { issueId: approvalCopyIssue.id, offsetHours: -6.0 },
    { issueId: permissionsIssue.id, offsetHours: -5.0 },
    { issueId: onboardingIssue.id, offsetHours: -4.0 },
    { issueId: importGuideIssue.id, offsetHours: -3.5 },
    { issueId: hiringIssue.id, offsetHours: -2.0 },
    { issueId: approvalsInboxIssue.id, offsetHours: -1.5 },
    { issueId: crashTelemetryIssue.id, offsetHours: -1.0 },
  ];
  await Promise.all(
    issueSchedule.map(({ issueId, offsetHours }) =>
      db.update(issues).set({ createdAt: new Date(isoAt(now, offsetHours)) }).where(eq(issues.id, issueId)),
    ),
  );

  await db.update(approvals).set({ createdAt: new Date(isoAt(now, -1.2)), updatedAt: new Date(isoAt(now, -1.2)) }).where(eq(approvals.id, publishApproval.id));
  await db.update(approvals).set({ createdAt: new Date(isoAt(now, -6.5)), updatedAt: new Date(isoAt(now, -6.5)) }).where(eq(approvals.id, staffingApproval.id));
  await db.update(chatConversations).set({ createdAt: new Date(isoAt(now, -0.9)), updatedAt: new Date(isoAt(now, -0.9)) }).where(eq(chatConversations.id, chat.id));

  const launchActivityIds = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(eq(activityLog.orgId, org.id))
    .orderBy(desc(activityLog.createdAt));
  const spacedTimes = [
    isoAt(now, -20.0),
    isoAt(now, -19.0),
    isoAt(now, -18.0),
    isoAt(now, -10.0),
    isoAt(now, -8.0),
    isoAt(now, -7.0),
    isoAt(now, -6.0),
    isoAt(now, -3.5),
    isoAt(now, -2.8),
    isoAt(now, -2.0),
    isoAt(now, -1.2),
    isoAt(now, -0.9),
  ];
  await Promise.all(
    launchActivityIds.slice(0, spacedTimes.length).map((row, index) =>
      db.update(activityLog).set({ createdAt: new Date(spacedTimes[index]!) }).where(eq(activityLog.id, row.id)),
    ),
  );

  return {
    org,
    projects,
    agents: {
      ceo,
      foundingEngineer,
      designEngineer,
      releaseEngineer,
      growthLead,
      supportOps,
    },
    issues: {
      main: mainIssue,
      crash: crashIssue,
      brief: briefIssue,
      onboarding: onboardingIssue,
      approvalCopy: approvalCopyIssue,
      transcript: transcriptIssue,
      hiring: hiringIssue,
      homepage: homepageIssue,
      faq: faqIssue,
      profileMigration: profileMigrationIssue,
      crashTelemetry: crashTelemetryIssue,
      permissions: permissionsIssue,
      importGuide: importGuideIssue,
      audit: auditIssue,
      soc2: soc2Issue,
      releaseChecklist: releaseChecklistIssue,
      nightlySmoke: nightlySmokeIssue,
      chatAutomation: chatAutomationIssue,
      approvalsInbox: approvalsInboxIssue,
    },
    approvals: {
      publish: publishApproval,
      staffing: staffingApproval,
    },
    chats: {
      intake: chat,
    },
  };
}

async function setSelectedOrg(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((value) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", value);
  }, orgId);
}

async function waitForLocator(locator: Locator) {
  await expect(locator).toBeVisible({ timeout: 30_000 });
  await locator.scrollIntoViewIfNeeded();
}

async function locatorBox(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Locator box unavailable");
  return box;
}

async function captureLocator(page: Page, locator: Locator, filename: string, padding = { x: 16, y: 16 }) {
  const box = await locatorBox(locator);
  const clip = {
    x: Math.max(0, box.x - padding.x),
    y: Math.max(0, box.y - padding.y),
    width: box.width + padding.x * 2,
    height: box.height + padding.y * 2,
  };
  await page.screenshot({
    path: path.join(SHOTS_DIR, filename),
    clip,
  });
}

async function captureDashboard(page: Page, orgPrefix: string) {
  console.log("capture: dashboard");
  await page.goto(orgRoute(orgPrefix, "/dashboard"));
  await waitForLocator(page.locator("#main-content"));
  await page.waitForTimeout(1200);
  const main = page.locator("#main-content");
  await captureLocator(page, main.locator("div.space-y-6").first(), "dashboard-control-plane.png", { x: 18, y: 18 });
}

async function captureChatCreateIssue(page: Page, seed: SeedContext) {
  console.log("capture: chat proposal");
  await page.goto(orgRoute(seed.org.issuePrefix, `/chat/${seed.chats.intake.id}`));
  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill("Create an issue to ship the enterprise pricing comparison page before Friday. It needs competitor callouts, two customer proof points, and a draft CTA.");
  await page.getByRole("button", { name: "Send" }).click();
  const reviewBlock = page.getByTestId("proposal-review-block").last();
  await expect(reviewBlock).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
  await captureLocator(page, page.locator("#main-content"), "chat-create-issue-proposal.png", { x: 18, y: 18 });

  await reviewBlock.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator("#main-content")).toContainText("Created issue", { timeout: 30_000 });
  await page.waitForTimeout(800);
  await captureLocator(page, page.locator("#main-content"), "chat-create-issue.png", { x: 18, y: 18 });
}

async function captureIssue(page: Page, orgPrefix: string) {
  console.log("capture: issue");
  await page.goto(orgRoute(orgPrefix, "/issues"));
  const main = page.locator("#main-content");
  await expect(main).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  await captureLocator(page, main, "issue-execution-loop.png", { x: 18, y: 18 });
}

async function captureIssuesCrossProject(page: Page, orgPrefix: string) {
  console.log("capture: issues cross-project");
  await page.goto(orgRoute(orgPrefix, "/issues?groupBy=project"));
  const main = page.locator("#main-content");
  await expect(main).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  await captureLocator(page, main, "issues-cross-project-overview.png", { x: 18, y: 18 });
}

async function captureApproval(page: Page, seed: SeedContext) {
  console.log("capture: approval");
  await page.goto(orgRoute(seed.org.issuePrefix, `/messenger/approvals/${seed.approvals.publish.id}`));
  const dialog = page.getByTestId("approval-detail-dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(600);
  await captureLocator(page, dialog, "approval-review.png", { x: 18, y: 18 });
}

async function captureHeartbeats(page: Page, orgPrefix: string) {
  console.log("capture: heartbeats");
  await page.goto(orgRoute(orgPrefix, "/heartbeats"));
  const main = page.locator("#main-content");
  await expect(main).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  await captureLocator(page, main, "heartbeats-team-ops.png", { x: 18, y: 18 });
}

async function captureCosts(page: Page, orgPrefix: string) {
  console.log("capture: costs");
  await page.goto(orgRoute(orgPrefix, "/costs"));
  const main = page.locator("#main-content");
  await expect(main).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  await captureLocator(page, main, "costs-budget-control.png", { x: 18, y: 18 });
}

async function captureOrgChart(page: Page, orgPrefix: string) {
  console.log("capture: org chart");
  await page.goto(orgRoute(orgPrefix, "/org"));
  const main = page.locator("#main-content");
  await expect(main).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  await captureLocator(page, main, "org-structure.png", { x: 18, y: 18 });
}

async function writeManifest() {
  const files = await fs.readdir(SHOTS_DIR);
  const manifest = {
    generatedAt: new Date().toISOString(),
    screenshots: files.filter((file) => file.endsWith(".png")).sort(),
    notes: "Generated from an isolated local_trusted Rudder instance for landing proof shots.",
  };
  await fs.writeFile(path.join(OUTPUT_ROOT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

async function waitForTerminationSignal() {
  await new Promise<void>((resolve) => {
    const onSignal = () => resolve();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

async function main() {
  await ensureEmptyDir(OUTPUT_ROOT);
  await fs.mkdir(SHOTS_DIR, { recursive: true });
  await writeCaptureConfig();
  await writeChatStub();

  const server = await startServer();
  try {
    console.log("runtime: resolving");
    const runtime = await resolveRuntimeInfo();
    console.log(`runtime: ${runtime.baseUrl} / ${runtime.dbUrl}`);
    const seedApi = await request.newContext({ baseURL: runtime.baseUrl });
    console.log("seed: start");
    const seed = await seedDemoOrg(seedApi, runtime.dbUrl);
    console.log("seed: complete");
    console.log(JSON.stringify({
      outputRoot: OUTPUT_ROOT,
      baseUrl: runtime.baseUrl,
      dbUrl: runtime.dbUrl,
      seed,
      screenshots: [
        "dashboard-control-plane.png",
        "chat-create-issue-proposal.png",
        "chat-create-issue.png",
        "issue-execution-loop.png",
        "issues-cross-project-overview.png",
        "approval-review.png",
        "heartbeats-team-ops.png",
        "costs-budget-control.png",
        "org-structure.png",
      ].map((file) => path.join(SHOTS_DIR, file)),
      serverLog: SERVER_LOG_PATH,
    }, null, 2));

    if (!SKIP_CAPTURE) {
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({
          baseURL: runtime.baseUrl,
          viewport: { width: 1728, height: 1180 },
          colorScheme: "light",
        });
        const page = await context.newPage();
        await setSelectedOrg(page, seed.org.id);
        await captureDashboard(page, seed.org.issuePrefix);
        await captureChatCreateIssue(page, seed);
        await captureIssue(page, seed.org.issuePrefix);
        await captureIssuesCrossProject(page, seed.org.issuePrefix);
        await captureApproval(page, seed);
        await captureHeartbeats(page, seed.org.issuePrefix);
        await captureCosts(page, seed.org.issuePrefix);
        await captureOrgChart(page, seed.org.issuePrefix);
        await context.close();
      } finally {
        await browser.close();
      }
      await writeManifest();
    }

    await seedApi.dispose();
    if (HOLD_OPEN) {
      console.log("runtime: holding open for manual capture");
      await waitForTerminationSignal();
    }
  } finally {
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
