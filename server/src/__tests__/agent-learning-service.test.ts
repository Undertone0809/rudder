import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentSkillRevisions,
  agentEnabledSkills,
  activityLog,
  agents,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  feedbackBatches,
  heartbeatRuns,
  learningCandidates,
  organizationSkillRevisions,
  organizationSkills,
  organizations,
  runFeedbackItems,
  runFeedbackSessions,
  skillEvidenceLinks,
  skillUpdateProposals,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { agentLearningService } from "../services/agent-learning.js";

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
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-agent-learning-db-"));
    const port = await getAvailablePort();
    const logs: unknown[] = [];
    const instance = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "rudder",
      password: "rudder",
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: () => {},
      onError: (message) => logs.push(message),
    });

    try {
      await instance.initialise();
      await instance.start();

      const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
      await ensurePostgresDatabase(adminConnectionString, "rudder");
      const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
      await applyPendingMigrations(connectionString);
      return { connectionString, dataDir, instance };
    } catch (error) {
      lastError = logs.length > 0
        ? new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.map(String).join("\n")}`)
        : error;
      await instance.stop().catch(() => {});
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

describe("agentLearningService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof agentLearningService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let rudderHome = "";
  const originalRudderHome = process.env.RUDDER_HOME;
  const originalRudderInstanceId = process.env.RUDDER_INSTANCE_ID;

  beforeAll(async () => {
    rudderHome = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-agent-learning-home-"));
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = `test-${randomUUID().slice(0, 8)}`;

    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    svc = agentLearningService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    if (!db) return;
    await db.delete(activityLog);
    await db.delete(skillEvidenceLinks);
    await db.delete(skillUpdateProposals);
    await db.delete(agentSkillRevisions);
    await db.delete(organizationSkillRevisions);
    await db.delete(learningCandidates);
    await db.delete(feedbackBatches);
    await db.delete(runFeedbackItems);
    await db.delete(runFeedbackSessions);
    await db.delete(heartbeatRuns);
    await db.delete(agentEnabledSkills);
    await db.delete(organizationSkills);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    if (db) await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    if (rudderHome) fs.rmSync(rudderHome, { recursive: true, force: true });
    if (originalRudderHome === undefined) delete process.env.RUDDER_HOME;
    else process.env.RUDDER_HOME = originalRudderHome;
    if (originalRudderInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
    else process.env.RUDDER_INSTANCE_ID = originalRudderInstanceId;
  });

  it("turns run feedback into an AI proposal, approved skill revision, and enabled agent skill", { timeout: 30000 }, async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const followupRunId = randomUUID();
    const actor = {
      actorType: "user" as const,
      actorId: "local-board",
      agentId: null,
      runId: null,
    };

    await db.insert(organizations).values({
      id: orgId,
      name: "Learning Org",
      urlKey: deriveOrganizationUrlKey("Learning Org"),
      issuePrefix: "Lrn",
      status: "active",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Founding Engineer",
      role: "engineer",
      status: "idle",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId,
      agentId,
      invocationSource: "on_demand",
      status: "succeeded",
      stdoutExcerpt: "edited files without reading AGENTS.md",
      createdAt: new Date("2026-05-02T10:00:00.000Z"),
      updatedAt: new Date("2026-05-02T10:05:00.000Z"),
    });

    const session = await svc.createSession(orgId, { targetAgentId: agentId }, actor);
    await svc.addFeedbackItem(orgId, session.id, {
      runId,
      sourceKind: "transcript",
      selectedTextSnapshot: "Started editing before reading AGENTS.md",
      body: "Before editing code, read AGENTS.md and task-specific project instructions.",
    });
    const submitted = await svc.submitSession(orgId, session.id, actor);

    expect(submitted.candidates).toHaveLength(1);
    expect(submitted.candidates[0]).toMatchObject({
      title: "Read project instructions before editing",
      classification: "core_behavior",
      status: "pending",
    });

    const reviewBeforeApply = await svc.getBatchReview(orgId, submitted.batch.id);
    expect(reviewBeforeApply.proposals).toEqual([
      expect.objectContaining({
        targetAgentId: agentId,
        status: "pending",
        title: "AI proposal: update Learning",
      }),
    ]);
    expect(reviewBeforeApply.proposals[0]!.markdownDiff).toContain("+ Read project instructions before editing");

    const applied = await svc.applyProposal(orgId, reviewBeforeApply.proposals[0]!.id, actor);

    expect(applied.skill).toMatchObject({
      name: "Learning",
    });
    expect(applied.revisions).toHaveLength(1);
    expect(applied.revisions[0]!.revision).toBe(1);
    expect(applied.revisions[0]!.markdown).toContain("Before editing code or project artifacts");

    const enabled = await db.select().from(agentEnabledSkills);
    expect(enabled).toEqual([
      expect.objectContaining({
        agentId,
        skillKey: applied.skill!.selectionKey,
      }),
    ]);

    const proposals = await db.select().from(skillUpdateProposals);
    expect(proposals).toEqual([
      expect.objectContaining({
        targetAgentId: agentId,
        status: "applied",
      }),
    ]);

    const summary = await svc.agentSummary(orgId, agentId);
    expect(summary.stats.activeLearningCount).toBe(1);
    expect(summary.stats.recentFeedbackCount).toBe(1);
    expect(summary.recentFeedbackItems[0]).toMatchObject({
      body: "Before editing code, read AGENTS.md and task-specific project instructions.",
    });
    expect(summary.activeLearnings[0]).toMatchObject({
      title: "Read project instructions before editing",
    });
    await expect(
      svc.updateCandidate(orgId, submitted.candidates[0]!.id, {
        title: "Edit applied learning",
      }),
    ).rejects.toThrow("Applied learnings are locked");

    await db.insert(heartbeatRuns).values({
      id: followupRunId,
      orgId,
      agentId,
      invocationSource: "on_demand",
      status: "succeeded",
      stdoutExcerpt: "Read AGENTS.md before editing. Done.",
      createdAt: new Date("2026-05-02T11:00:00.000Z"),
      updatedAt: new Date("2026-05-02T11:05:00.000Z"),
    });

    await svc.recordRunLoadedSkills(orgId, followupRunId, agentId, [
      { key: applied.skill!.selectionKey },
    ]);

    await db.insert(agentSkillRevisions).values({
      orgId,
      agentId,
      skillKey: applied.skill!.selectionKey,
      skillSlug: applied.skill!.slug,
      revision: 2,
      markdown: "# Later revision",
      structuredSpecJson: {
        activeLearnings: [
          {
            id: "later-learning",
            title: "Later learning",
            instruction: "This learning was not loaded by the follow-up run.",
            appliesWhenJson: {},
            mustNot: null,
            validationChecksJson: [],
          },
        ],
      },
      contentHash: "later-revision",
      status: "approved",
    });

    const loaded = await svc.getRunLoadedSkills(orgId, followupRunId);
    expect(loaded.loadedSkills).toEqual([
      expect.objectContaining({
        skillName: "Learning",
        revision: 1,
        recentLearnings: [
          expect.objectContaining({
            title: "Read project instructions before editing",
          }),
        ],
      }),
    ]);

    const evaluations = await svc.evaluateRunSkills(orgId, followupRunId);
    expect(evaluations).toEqual([
      expect.objectContaining({
        score: 1,
        passedItemsJson: ["Read project instructions before editing"],
        missedItemsJson: [],
      }),
    ]);
  });
});
