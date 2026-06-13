import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Scenario = {
  name: string;
  timezone: string;
  anchorNow: string;
  historyStart: string;
  organization: {
    name: string;
    description: string;
    urlKeyBase: string;
    issuePrefixBase: string;
    budgetMonthlyCents: number;
    brandColor: string;
    defaultChatIssueCreationMode: string;
  };
  generation: {
    issueNumberStart: number;
    provider: string;
    biller: string;
    billingType: string;
    defaultModel: string;
    calendarSourceName: string;
    operatorCalendarSourceName: string;
    createDerivedRunCalendarEvents: boolean;
    createIssueComments: boolean;
    createActivityLog: boolean;
  };
  goals: Array<{
    key: string;
    title: string;
    description: string;
    level: string;
    status: string;
    ownerAgentKey?: string;
  }>;
  projects: Array<{
    key: string;
    name: string;
    description: string;
    status: string;
    goalKey?: string;
    leadAgentKey?: string;
    targetDate?: string;
    color?: string;
  }>;
};

type AgentFixture = {
  key: string;
  name: string;
  role: string;
  title: string;
  icon: string;
  status: string;
  reportsToKey?: string;
  budgetMonthlyCents: number;
  heartbeatIntervalSec: number;
  capabilities: string;
};

type IssueFixture = {
  key: string;
  projectKey: string;
  goalKey: string;
  assigneeKey?: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  day: number;
  billingCode: string;
  runProfile: {
    runs: number;
    costCents: number;
    depth: number;
    failure?: string;
  };
};

type ApprovalFixture = {
  key: string;
  type: string;
  status: string;
  requestedByAgentKey?: string;
  issueKeys?: string[];
  day: number;
  decisionNote?: string;
  payload: Record<string, unknown>;
};

type CalendarFixture = {
  key: string;
  title: string;
  description: string;
  ownerType: string;
  day: number;
  startHour: number;
  durationMinutes: number;
  eventKind: string;
  eventStatus: string;
  projectKey?: string;
  goalKey?: string;
};

type ChatFixture = {
  key: string;
  title: string;
  summary: string;
  preferredAgentKey?: string;
  primaryIssueKey?: string;
  contextIssueKeys?: string[];
  day: number;
  messages: Array<{
    role: string;
    body: string;
    replyingAgentKey?: string;
  }>;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../../../..");
const DATA_DIR = path.resolve(SCRIPT_DIR, "../data/rudder-studio");
const requireFromDb = createRequire(path.join(REPO_ROOT, "packages/db/package.json"));
const { and, eq, sql } = requireFromDb("drizzle-orm");
const dbModule = await import(pathToFileURL(path.join(REPO_ROOT, "packages/db/src/index.ts")).href);
const {
  activityLog,
  agents,
  approvals,
  calendarEvents,
  calendarSources,
  chatContextLinks,
  chatConversations,
  chatMessages,
  costEvents,
  createDb,
  goals,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issues,
  organizations,
  projectGoals,
  projects,
} = dbModule as any;
const argv = new Set(process.argv.slice(2));
const dryRun = argv.has("--dry-run");

async function readJson<T>(name: string): Promise<T> {
  const content = await readFile(path.join(DATA_DIR, name), "utf8");
  return JSON.parse(content) as T;
}

function mustGet<T>(map: Map<string, T>, key: string, label: string): T {
  const value = map.get(key);
  if (!value) throw new Error(`Unknown ${label} key: ${key}`);
  return value;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function atDay(historyStart: Date, day: number, hour: number, minute = 0): Date {
  const next = addDays(historyStart, day);
  next.setHours(hour, minute, 0, 0);
  return next;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42);
}

async function resolveDatabaseUrl(): Promise<string> {
  if (process.env.RUDDER_STUDIO_DATABASE_URL) return process.env.RUDDER_STUDIO_DATABASE_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  return "postgres://rudder:rudder@127.0.0.1:54329/rudder";
}

async function resolveDevApiUrl(): Promise<string> {
  if (process.env.RUDDER_STUDIO_BASE_URL) {
    return process.env.RUDDER_STUDIO_BASE_URL.replace(/\/+$/, "");
  }

  try {
    const runtimePath = path.join(homedir(), ".rudder/instances/dev/runtime/server.json");
    const runtime = JSON.parse(await readFile(runtimePath, "utf8")) as { apiUrl?: string };
    if (runtime.apiUrl) return runtime.apiUrl.replace(/\/+$/, "");
  } catch {
    // The route is only printed for convenience; the seed itself uses the DB.
  }

  return "http://127.0.0.1:3100";
}

async function nextAvailableKeys(db: any, urlKeyBase: string, issuePrefixBase: string) {
  const fixedKeys = process.env.RUDDER_STUDIO_FIXED_KEYS === "1";
  for (let index = 0; index < 100; index += 1) {
    const urlKey = index === 0 ? urlKeyBase : `${urlKeyBase}-${index + 1}`;
    const issuePrefix = index === 0 ? issuePrefixBase : `${issuePrefixBase}${index + 1}`;
    const existingUrl = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.urlKey, urlKey))
      .limit(1);
    const existingPrefix = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.issuePrefix, issuePrefix))
      .limit(1);

    if (existingUrl.length === 0 && existingPrefix.length === 0) return { urlKey, issuePrefix };
    if (fixedKeys) {
      throw new Error(
        `Rudder Studio already exists for urlKey=${urlKey} or issuePrefix=${issuePrefix}. ` +
          "Unset RUDDER_STUDIO_FIXED_KEYS or reset the local dev instance.",
      );
    }
  }

  throw new Error("Could not find available Rudder Studio org keys.");
}

function validateReferences(
  scenario: Scenario,
  agentFixtures: AgentFixture[],
  issueFixtures: IssueFixture[],
  approvalsFixtures: ApprovalFixture[],
  calendarFixtures: CalendarFixture[],
  chatFixtures: ChatFixture[],
) {
  const agentKeys = new Set(agentFixtures.map((agent) => agent.key));
  const goalKeys = new Set(scenario.goals.map((goal) => goal.key));
  const projectKeys = new Set(scenario.projects.map((project) => project.key));
  const issueKeys = new Set(issueFixtures.map((issue) => issue.key));

  for (const agent of agentFixtures) {
    if (agent.reportsToKey && !agentKeys.has(agent.reportsToKey)) throw new Error(`Bad reportsToKey: ${agent.key}`);
  }
  for (const goal of scenario.goals) {
    if (goal.ownerAgentKey && !agentKeys.has(goal.ownerAgentKey)) throw new Error(`Bad goal owner: ${goal.key}`);
  }
  for (const project of scenario.projects) {
    if (project.goalKey && !goalKeys.has(project.goalKey)) throw new Error(`Bad project goal: ${project.key}`);
    if (project.leadAgentKey && !agentKeys.has(project.leadAgentKey)) {
      throw new Error(`Bad project lead: ${project.key}`);
    }
  }
  for (const issue of issueFixtures) {
    if (!projectKeys.has(issue.projectKey)) throw new Error(`Bad issue project: ${issue.key}`);
    if (!goalKeys.has(issue.goalKey)) throw new Error(`Bad issue goal: ${issue.key}`);
    if (issue.assigneeKey && !agentKeys.has(issue.assigneeKey)) throw new Error(`Bad issue assignee: ${issue.key}`);
  }
  for (const approval of approvalsFixtures) {
    if (approval.requestedByAgentKey && !agentKeys.has(approval.requestedByAgentKey)) {
      throw new Error(`Bad approval requester: ${approval.key}`);
    }
    for (const issueKey of approval.issueKeys ?? []) {
      if (!issueKeys.has(issueKey)) throw new Error(`Bad approval issue: ${approval.key}/${issueKey}`);
    }
  }
  for (const event of calendarFixtures) {
    if (event.projectKey && !projectKeys.has(event.projectKey)) throw new Error(`Bad calendar project: ${event.key}`);
    if (event.goalKey && !goalKeys.has(event.goalKey)) throw new Error(`Bad calendar goal: ${event.key}`);
  }
  for (const chat of chatFixtures) {
    if (chat.preferredAgentKey && !agentKeys.has(chat.preferredAgentKey)) throw new Error(`Bad chat agent: ${chat.key}`);
    if (chat.primaryIssueKey && !issueKeys.has(chat.primaryIssueKey)) throw new Error(`Bad chat issue: ${chat.key}`);
    for (const issueKey of chat.contextIssueKeys ?? []) {
      if (!issueKeys.has(issueKey)) throw new Error(`Bad chat context issue: ${chat.key}/${issueKey}`);
    }
  }
}

function runStatusForIssue(issue: IssueFixture, runIndex: number): string {
  const isLast = runIndex === issue.runProfile.runs - 1;
  if (!isLast) return "completed";
  if (issue.status === "in_progress") return "running";
  if (issue.status === "blocked") return "failed";
  if (issue.status === "todo" || issue.status === "backlog") return "queued";
  return "completed";
}

async function main() {
  const [scenario, agentFixtures, issueFixtures, approvalsFixtures, calendarFixtures, chatFixtures] =
    await Promise.all([
      readJson<Scenario>("scenario.json"),
      readJson<AgentFixture[]>("agents.json"),
      readJson<IssueFixture[]>("issues.json"),
      readJson<ApprovalFixture[]>("approvals.json"),
      readJson<CalendarFixture[]>("calendar.json"),
      readJson<ChatFixture[]>("chats.json"),
    ]);

  validateReferences(scenario, agentFixtures, issueFixtures, approvalsFixtures, calendarFixtures, chatFixtures);

  const expectedRuns = issueFixtures.reduce((sum, issue) => sum + issue.runProfile.runs, 0);
  if (dryRun) {
    console.log(`Rudder Studio fixture OK: ${agentFixtures.length} agents, ${scenario.goals.length} goals, ${scenario.projects.length} projects, ${issueFixtures.length} issues, ${expectedRuns} generated runs.`);
    return;
  }

  const db = createDb(await resolveDatabaseUrl());
  const apiUrl = await resolveDevApiUrl();
  const historyStart = new Date(scenario.historyStart);
  const now = new Date(scenario.anchorNow);
  const { urlKey, issuePrefix } = await nextAvailableKeys(
    db,
    process.env.RUDDER_STUDIO_URL_KEY ?? scenario.organization.urlKeyBase,
    process.env.RUDDER_STUDIO_ISSUE_PREFIX ?? scenario.organization.issuePrefixBase,
  );

  const orgId = randomUUID();
  await db.insert(organizations).values({
    id: orgId,
    urlKey,
    name: scenario.organization.name,
    description: scenario.organization.description,
    status: "active",
    issuePrefix,
    issueCounter: scenario.generation.issueNumberStart + issueFixtures.length - 1,
    budgetMonthlyCents: scenario.organization.budgetMonthlyCents,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    defaultChatIssueCreationMode: scenario.organization.defaultChatIssueCreationMode,
    brandColor: scenario.organization.brandColor,
    createdAt: historyStart,
    updatedAt: now,
  });

  const agentIds = new Map<string, string>();
  for (const fixture of agentFixtures) agentIds.set(fixture.key, randomUUID());

  await db.insert(agents).values(agentFixtures.map((fixture) => ({
    id: mustGet(agentIds, fixture.key, "agent"),
    orgId,
    name: fixture.name,
    workspaceKey: `rudder-studio-${fixture.key}`,
    role: fixture.role,
    title: fixture.title,
    icon: fixture.icon,
    status: fixture.status,
    reportsTo: fixture.reportsToKey ? mustGet(agentIds, fixture.reportsToKey, "agent") : null,
    capabilities: fixture.capabilities,
    agentRuntimeType: "process",
    agentRuntimeConfig: {
      command: "node",
      args: ["-e", "console.log('Rudder Studio demo agent: no live execution')"],
    },
    runtimeConfig: {
      heartbeat: {
        enabled: false,
        intervalSec: fixture.heartbeatIntervalSec,
      },
      seed: "rudder-studio",
    },
    budgetMonthlyCents: fixture.budgetMonthlyCents,
    spentMonthlyCents: 0,
    pauseReason: fixture.status === "paused" ? "monthly_budget_review" : null,
    pausedAt: fixture.status === "paused" ? atDay(historyStart, 28, 12) : null,
    permissions: { canCreateAgents: fixture.role === "ceo" || fixture.role === "cto" },
    metadata: { fixtureKey: fixture.key, scenario: "rudder-studio" },
    lastHeartbeatAt: atDay(historyStart, 28, 16),
    createdAt: atDay(historyStart, 0, 9),
    updatedAt: now,
  })));

  const goalIds = new Map<string, string>();
  for (const fixture of scenario.goals) goalIds.set(fixture.key, randomUUID());

  await db.insert(goals).values(scenario.goals.map((fixture) => ({
    id: mustGet(goalIds, fixture.key, "goal"),
    orgId,
    title: fixture.title,
    description: fixture.description,
    level: fixture.level,
    status: fixture.status,
    ownerAgentId: fixture.ownerAgentKey ? mustGet(agentIds, fixture.ownerAgentKey, "agent") : null,
    createdAt: historyStart,
    updatedAt: now,
  })));

  const projectIds = new Map<string, string>();
  for (const fixture of scenario.projects) projectIds.set(fixture.key, randomUUID());

  await db.insert(projects).values(scenario.projects.map((fixture) => ({
    id: mustGet(projectIds, fixture.key, "project"),
    orgId,
    goalId: fixture.goalKey ? mustGet(goalIds, fixture.goalKey, "goal") : null,
    name: fixture.name,
    description: fixture.description,
    status: fixture.status,
    leadAgentId: fixture.leadAgentKey ? mustGet(agentIds, fixture.leadAgentKey, "agent") : null,
    targetDate: fixture.targetDate ?? null,
    color: fixture.color ?? null,
    createdAt: historyStart,
    updatedAt: now,
  })));

  await db.insert(projectGoals).values(scenario.projects
    .filter((fixture) => fixture.goalKey)
    .map((fixture) => ({
      projectId: mustGet(projectIds, fixture.key, "project"),
      goalId: mustGet(goalIds, fixture.goalKey as string, "goal"),
      orgId,
      createdAt: historyStart,
      updatedAt: now,
    })));

  const issueIds = new Map<string, string>();
  for (const fixture of issueFixtures) issueIds.set(fixture.key, randomUUID());

  await db.insert(issues).values(issueFixtures.map((fixture, index) => {
    const createdAt = atDay(historyStart, fixture.day, 9 + (index % 7));
    const issueNumber = scenario.generation.issueNumberStart + index;
    return {
      id: mustGet(issueIds, fixture.key, "issue"),
      orgId,
      projectId: mustGet(projectIds, fixture.projectKey, "project"),
      goalId: mustGet(goalIds, fixture.goalKey, "goal"),
      title: fixture.title,
      description: fixture.description,
      status: fixture.status,
      priority: fixture.priority,
      assigneeAgentId: fixture.assigneeKey ? mustGet(agentIds, fixture.assigneeKey, "agent") : null,
      createdByUserId: "local-board",
      issueNumber,
      identifier: `${issuePrefix}-${issueNumber}`,
      originKind: "manual",
      requestDepth: fixture.runProfile.depth,
      billingCode: fixture.billingCode,
      startedAt: ["in_progress", "in_review", "done", "blocked"].includes(fixture.status) ? addMinutes(createdAt, 45) : null,
      completedAt: fixture.status === "done" ? atDay(historyStart, Math.min(fixture.day + 3, 28), 17) : null,
      createdAt,
      updatedAt: fixture.status === "done" ? atDay(historyStart, Math.min(fixture.day + 3, 28), 17) : now,
    };
  }));

  const sourceId = randomUUID();
  const operatorSourceId = randomUUID();
  await db.insert(calendarSources).values([
    {
      id: sourceId,
      orgId,
      type: "agent_work",
      name: scenario.generation.calendarSourceName,
      ownerType: "system",
      status: "active",
      createdAt: historyStart,
      updatedAt: now,
    },
    {
      id: operatorSourceId,
      orgId,
      type: "rudder_local",
      name: scenario.generation.operatorCalendarSourceName,
      ownerType: "user",
      ownerUserId: "local-board",
      status: "active",
      createdAt: historyStart,
      updatedAt: now,
    },
  ]);

  const agentSpend = new Map<string, number>();
  let orgSpend = 0;
  let runCount = 0;
  for (const [issueIndex, fixture] of issueFixtures.entries()) {
    const issueId = mustGet(issueIds, fixture.key, "issue");
    const agentId = fixture.assigneeKey ? mustGet(agentIds, fixture.assigneeKey, "agent") : mustGet(agentIds, "ada", "agent");
    const projectId = mustGet(projectIds, fixture.projectKey, "project");
    const goalId = mustGet(goalIds, fixture.goalKey, "goal");
    const runIds: string[] = [];
    const perRunCost = Math.max(40, Math.round(fixture.runProfile.costCents / Math.max(1, fixture.runProfile.runs)));

    for (let runIndex = 0; runIndex < fixture.runProfile.runs; runIndex += 1) {
      const runId = randomUUID();
      const runDay = Math.min(28, fixture.day + Math.floor((runIndex * 4) / Math.max(1, fixture.runProfile.runs)));
      const startedAt = atDay(historyStart, runDay, 8 + ((issueIndex + runIndex) % 10), (issueIndex * 7 + runIndex * 13) % 50);
      const status = runStatusForIssue(fixture, runIndex);
      const finishedAt = status === "running" || status === "queued" ? null : addMinutes(startedAt, 22 + ((issueIndex + runIndex) % 7) * 9);
      const costCents = runIndex === fixture.runProfile.runs - 1
        ? fixture.runProfile.costCents - perRunCost * (fixture.runProfile.runs - 1)
        : perRunCost;

      await db.insert(heartbeatRuns).values({
        id: runId,
        orgId,
        agentId,
        invocationSource: runIndex === 0 ? "assignment" : "timer",
        triggerDetail: runIndex === 0 ? "issue_assigned" : "scheduled_heartbeat",
        status,
        startedAt,
        finishedAt,
        error: status === "failed" ? fixture.runProfile.failure ?? "Seeded failure for blocked work" : null,
        exitCode: status === "failed" ? 1 : status === "completed" ? 0 : null,
        usageJson: {
          inputTokens: 5200 + runIndex * 240,
          outputTokens: 900 + runIndex * 90,
          cachedInputTokens: 1100 + runIndex * 60,
        },
        resultJson: {
          issueKey: fixture.key,
          projectKey: fixture.projectKey,
          outcome: status === "completed" ? "progress_recorded" : status,
          summary: fixture.title,
        },
        contextSnapshot: {
          scenario: "rudder-studio",
          issue: { key: fixture.key, title: fixture.title, status: fixture.status },
          projectKey: fixture.projectKey,
          billingCode: fixture.billingCode,
        },
        stdoutExcerpt: status === "completed" ? `Completed work on ${fixture.key}: ${fixture.title}` : null,
        stderrExcerpt: status === "failed" ? fixture.runProfile.failure ?? "Seeded blocked run" : null,
        logStore: "mock-data-maintainer",
        logRef: `rudder-studio/${fixture.key}/${runIndex + 1}`,
        createdAt: startedAt,
        updatedAt: finishedAt ?? startedAt,
      });
      runIds.push(runId);
      runCount += 1;

      await db.insert(heartbeatRunEvents).values([
        {
          orgId,
          runId,
          agentId,
          seq: 1,
          eventType: "run.started",
          level: "info",
          message: `Started ${fixture.key}`,
          payload: { issueKey: fixture.key, projectKey: fixture.projectKey },
          createdAt: startedAt,
        },
        {
          orgId,
          runId,
          agentId,
          seq: 2,
          eventType: status === "failed" ? "run.failed" : status === "running" ? "run.running" : "run.completed",
          level: status === "failed" ? "error" : "info",
          message: status === "failed" ? fixture.runProfile.failure ?? "Run blocked" : `Recorded progress for ${fixture.key}`,
          payload: { issueKey: fixture.key, status },
          createdAt: finishedAt ?? addMinutes(startedAt, 8),
        },
      ]);

      if (status !== "queued") {
        await db.insert(costEvents).values({
          id: randomUUID(),
          orgId,
          agentId,
          issueId,
          projectId,
          goalId,
          heartbeatRunId: runId,
          billingCode: fixture.billingCode,
          provider: scenario.generation.provider,
          biller: scenario.generation.biller,
          billingType: scenario.generation.billingType,
          model: scenario.generation.defaultModel,
          inputTokens: 5200 + runIndex * 240,
          cachedInputTokens: 1100 + runIndex * 60,
          outputTokens: 900 + runIndex * 90,
          costCents,
          occurredAt: finishedAt ?? startedAt,
          createdAt: finishedAt ?? startedAt,
        });
        orgSpend += costCents;
        agentSpend.set(agentId, (agentSpend.get(agentId) ?? 0) + costCents);
      }

      if (scenario.generation.createDerivedRunCalendarEvents && status !== "queued") {
        await db.insert(calendarEvents).values({
          id: randomUUID(),
          orgId,
          sourceId,
          eventKind: "agent_work_block",
          eventStatus: status === "running" ? "in_progress" : "actual",
          ownerType: "agent",
          ownerAgentId: agentId,
          title: `${fixture.assigneeKey ?? "agent"}: ${fixture.title}`,
          description: `Derived from heartbeat run ${runIndex + 1} for ${fixture.key}.`,
          startAt: startedAt,
          endAt: finishedAt ?? addMinutes(startedAt, 50),
          timezone: scenario.timezone,
          allDay: false,
          visibility: "full",
          issueId,
          projectId,
          goalId,
          heartbeatRunId: runId,
          sourceMode: "derived",
          createdAt: startedAt,
          updatedAt: finishedAt ?? startedAt,
        });
      }
    }

    const lastRunId = runIds.at(-1) ?? null;
    if (lastRunId) {
      await db
        .update(issues)
        .set({
          executionRunId: lastRunId,
          checkoutRunId: ["in_progress", "blocked"].includes(fixture.status) ? lastRunId : null,
          updatedAt: now,
        })
        .where(eq(issues.id, issueId));
    }

    if (scenario.generation.createIssueComments && fixture.status !== "todo" && fixture.status !== "backlog") {
      await db.insert(issueComments).values({
        id: randomUUID(),
        orgId,
        issueId,
        authorAgentId: agentId,
        body: fixture.status === "blocked"
          ? `Blocked: ${fixture.runProfile.failure ?? "needs operator decision before continuing."}`
          : `Progress update: ${fixture.title} now has ${fixture.runProfile.runs} recorded agent runs in Rudder Studio.`,
        createdAt: atDay(historyStart, Math.min(28, fixture.day + 2), 13),
        updatedAt: atDay(historyStart, Math.min(28, fixture.day + 2), 13),
      });
    }

    if (scenario.generation.createActivityLog) {
      await db.insert(activityLog).values({
        id: randomUUID(),
        orgId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        runId: lastRunId,
        action: fixture.status === "done" ? "issue.completed" : "issue.progressed",
        entityType: "issue",
        entityId: issueId,
        details: { issueKey: fixture.key, projectKey: fixture.projectKey, status: fixture.status },
        createdAt: atDay(historyStart, Math.min(28, fixture.day + 2), 14),
      });
    }
  }

  for (const [agentId, spentMonthlyCents] of agentSpend.entries()) {
    await db.update(agents).set({ spentMonthlyCents, updatedAt: now }).where(eq(agents.id, agentId));
  }
  await db.update(organizations).set({ spentMonthlyCents: orgSpend, updatedAt: now }).where(eq(organizations.id, orgId));

  const approvalIds = new Map<string, string>();
  for (const fixture of approvalsFixtures) approvalIds.set(fixture.key, randomUUID());
  await db.insert(approvals).values(approvalsFixtures.map((fixture) => ({
    id: mustGet(approvalIds, fixture.key, "approval"),
    orgId,
    type: fixture.type,
    requestedByAgentId: fixture.requestedByAgentKey ? mustGet(agentIds, fixture.requestedByAgentKey, "agent") : null,
    requestedByUserId: "local-board",
    status: fixture.status,
    payload: fixture.payload,
    decisionNote: fixture.decisionNote ?? null,
    decidedByUserId: ["approved", "rejected", "revision_requested"].includes(fixture.status) ? "local-board" : null,
    decidedAt: ["approved", "rejected", "revision_requested"].includes(fixture.status)
      ? atDay(historyStart, Math.min(28, fixture.day + 1), 10)
      : null,
    createdAt: atDay(historyStart, fixture.day, 9),
    updatedAt: now,
  })));

  const approvalLinks = approvalsFixtures.flatMap((fixture) =>
    (fixture.issueKeys ?? []).map((issueKey) => ({
      orgId,
      issueId: mustGet(issueIds, issueKey, "issue"),
      approvalId: mustGet(approvalIds, fixture.key, "approval"),
      linkedByAgentId: fixture.requestedByAgentKey ? mustGet(agentIds, fixture.requestedByAgentKey, "agent") : null,
      linkedByUserId: "local-board",
      createdAt: atDay(historyStart, fixture.day, 9, 10),
    })),
  );
  if (approvalLinks.length > 0) await db.insert(issueApprovals).values(approvalLinks);

  await db.insert(calendarEvents).values(calendarFixtures.map((fixture) => {
    const startAt = atDay(historyStart, fixture.day, fixture.startHour);
    return {
      id: randomUUID(),
      orgId,
      sourceId: operatorSourceId,
      eventKind: fixture.eventKind,
      eventStatus: fixture.eventStatus,
      ownerType: fixture.ownerType,
      ownerUserId: "local-board",
      title: fixture.title,
      description: fixture.description,
      startAt,
      endAt: addMinutes(startAt, fixture.durationMinutes),
      timezone: scenario.timezone,
      allDay: false,
      visibility: "full",
      projectId: fixture.projectKey ? mustGet(projectIds, fixture.projectKey, "project") : null,
      goalId: fixture.goalKey ? mustGet(goalIds, fixture.goalKey, "goal") : null,
      sourceMode: "manual",
      createdByUserId: "local-board",
      updatedByUserId: "local-board",
      createdAt: startAt,
      updatedAt: startAt,
    };
  }));

  for (const fixture of chatFixtures) {
    const conversationId = randomUUID();
    const createdAt = atDay(historyStart, fixture.day, 12);
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      status: "active",
      title: fixture.title,
      summary: fixture.summary,
      preferredAgentId: fixture.preferredAgentKey ? mustGet(agentIds, fixture.preferredAgentKey, "agent") : null,
      routedAgentId: fixture.preferredAgentKey ? mustGet(agentIds, fixture.preferredAgentKey, "agent") : null,
      primaryIssueId: fixture.primaryIssueKey ? mustGet(issueIds, fixture.primaryIssueKey, "issue") : null,
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: "local-board",
      lastMessageAt: addMinutes(createdAt, fixture.messages.length * 5),
      createdAt,
      updatedAt: addMinutes(createdAt, fixture.messages.length * 5),
    });

    const contextIssueKeys = new Set([fixture.primaryIssueKey, ...(fixture.contextIssueKeys ?? [])].filter(Boolean) as string[]);
    for (const issueKey of contextIssueKeys) {
      await db.insert(chatContextLinks).values({
        id: randomUUID(),
        orgId,
        conversationId,
        entityType: "issue",
        entityId: mustGet(issueIds, issueKey, "issue"),
        metadata: { issueKey },
        createdAt,
        updatedAt: createdAt,
      });
    }

    for (const [messageIndex, message] of fixture.messages.entries()) {
      await db.insert(chatMessages).values({
        id: randomUUID(),
        orgId,
        conversationId,
        role: message.role,
        kind: "message",
        status: "completed",
        body: message.body,
        replyingAgentId: message.replyingAgentKey ? mustGet(agentIds, message.replyingAgentKey, "agent") : null,
        chatTurnId: randomUUID(),
        turnVariant: 0,
        createdAt: addMinutes(createdAt, messageIndex * 5),
        updatedAt: addMinutes(createdAt, messageIndex * 5),
      });
    }
  }

  const counts = await db
    .select({
      issueCount: sql<number>`count(*)::int`,
    })
    .from(issues)
    .where(eq(issues.orgId, orgId));
  const marketingCount = await db
    .select({ issueCount: sql<number>`count(*)::int` })
    .from(issues)
    .where(and(eq(issues.orgId, orgId), eq(issues.projectId, mustGet(projectIds, "marketing-growth", "project"))));

  console.log(`Seeded ${scenario.name}`);
  console.log(`Org id: ${orgId}`);
  console.log(`URL key: ${urlKey}`);
  console.log(`Issue prefix: ${issuePrefix}`);
  console.log(`Issues: ${counts[0]?.issueCount ?? issueFixtures.length} (${marketingCount[0]?.issueCount ?? 0} Marketing & Growth)`);
  console.log(`Generated runs: ${runCount}`);
  console.log(`Month spend: ${orgSpend} cents / budget ${scenario.organization.budgetMonthlyCents} cents`);
  console.log(`Open: ${apiUrl}/${urlKey}/dashboard`);
  console.log(`Marketing: ${apiUrl}/${urlKey}/issues?projectId=${mustGet(projectIds, "marketing-growth", "project")}`);
  console.log(`Calendar: ${apiUrl}/${urlKey}/calendar`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
