import { createDb, ensurePostgresDatabase, projectGoals, projects } from "@rudderhq/db";
import { eq, sql } from "drizzle-orm";
import EmbeddedPostgres from "embedded-postgres";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorktreeMergePlan, parseWorktreeMergeScopes } from "../commands/worktree-merge-history-lib.js";
import { applyMergePlan } from "../commands/worktree-merge.js";

async function availablePostgresPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate PostgreSQL port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

const worktreeMergeTestSchema = [
  `CREATE TABLE organizations (
    id uuid PRIMARY KEY,
    url_key text NOT NULL,
    name text NOT NULL,
    issue_prefix text NOT NULL,
    issue_counter integer NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE goals (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id),
    title text NOT NULL
  )`,
  `CREATE TABLE organization_mutation_state (
    org_id uuid PRIMARY KEY REFERENCES organizations(id),
    mutation_version bigint NOT NULL DEFAULT 0,
    fence_epoch bigint NOT NULL DEFAULT 0,
    fence_token uuid NOT NULL DEFAULT gen_random_uuid(),
    owner text NOT NULL DEFAULT 'node'
  )`,
  `CREATE TABLE projects (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id),
    goal_id uuid REFERENCES goals(id),
    name text NOT NULL,
    description text,
    status text NOT NULL,
    lead_agent_id uuid,
    target_date date,
    color text,
    icon text,
    pause_reason text,
    paused_at timestamptz,
    execution_workspace_policy jsonb,
    archived_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE TABLE project_goals (
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    goal_id uuid NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    org_id uuid NOT NULL REFERENCES organizations(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, goal_id)
  )`,
  `CREATE TABLE project_goal_mutation_state (
    project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    org_id uuid NOT NULL REFERENCES organizations(id),
    mutation_version bigint NOT NULL DEFAULT 0,
    fence_epoch bigint NOT NULL DEFAULT 0,
    fence_token uuid NOT NULL DEFAULT gen_random_uuid(),
    owner text NOT NULL DEFAULT 'node'
  )`,
  `CREATE TABLE project_goal_owner_seed (
    project_id uuid PRIMARY KEY,
    owner text NOT NULL
  )`,
  `CREATE FUNCTION provision_test_project_goal_mutation_state() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE requested_owner text;
    BEGIN
      SELECT owner INTO requested_owner
      FROM project_goal_owner_seed
      WHERE project_id = NEW.id;
      requested_owner := COALESCE(requested_owner, 'node');
      INSERT INTO project_goal_mutation_state (
        project_id, org_id, mutation_version, fence_epoch, fence_token, owner
      ) VALUES (
        NEW.id, NEW.org_id, 0,
        CASE WHEN requested_owner = 'rust' THEN 1 ELSE 0 END,
        gen_random_uuid(), requested_owner
      );
      RETURN NEW;
    END;
    $$`,
  `CREATE TRIGGER projects_test_project_goal_state
    AFTER INSERT ON projects
    FOR EACH ROW EXECUTE FUNCTION provision_test_project_goal_mutation_state()`,
  `CREATE TABLE issue_attachments (id uuid PRIMARY KEY, org_id uuid NOT NULL)`,
];

function makeGoalImportPlan(orgId: string, projectId: string, goalId: string) {
  return buildWorktreeMergePlan({
    orgId,
    companyName: "Rudder",
    issuePrefix: "PAP",
    previewIssueCounterStart: 0,
    scopes: ["issues"],
    sourceIssues: [],
    targetIssues: [],
    sourceComments: [],
    targetComments: [],
    sourceProjects: [makeProject({ id: projectId, orgId, goalId })],
    sourceProjectWorkspaces: [],
    targetAgents: [],
    targetProjects: [],
    targetProjectWorkspaces: [],
    targetGoals: [{ id: goalId, orgId }] as any,
    importProjectIds: [projectId],
  });
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    orgId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: "goal-1",
    parentId: null,
    title: "Issue",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAgentRuntimeOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: "comment-1",
    orgId: "company-1",
    issueId: "issue-1",
    authorAgentId: null,
    authorUserId: "local-board",
    body: "hello",
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeIssueDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-document-1",
    orgId: "company-1",
    issueId: "issue-1",
    documentId: "document-1",
    key: "plan",
    linkCreatedAt: new Date("2026-03-20T00:00:00.000Z"),
    linkUpdatedAt: new Date("2026-03-20T00:00:00.000Z"),
    title: "Plan",
    format: "markdown",
    latestBody: "# Plan",
    latestRevisionId: "revision-1",
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: "local-board",
    updatedByAgentId: null,
    updatedByUserId: "local-board",
    documentCreatedAt: new Date("2026-03-20T00:00:00.000Z"),
    documentUpdatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeDocumentRevision(overrides: Record<string, unknown> = {}) {
  return {
    id: "revision-1",
    orgId: "company-1",
    documentId: "document-1",
    revisionNumber: 1,
    body: "# Plan",
    changeSummary: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeAttachment(overrides: Record<string, unknown> = {}) {
  return {
    id: "attachment-1",
    orgId: "company-1",
    issueId: "issue-1",
    issueCommentId: null,
    assetId: "asset-1",
    provider: "local_disk",
    objectKey: "company-1/issues/issue-1/2026/03/20/asset.png",
    contentType: "image/png",
    byteSize: 12,
    sha256: "deadbeef",
    originalFilename: "asset.png",
    createdByAgentId: null,
    createdByUserId: "local-board",
    assetCreatedAt: new Date("2026-03-20T00:00:00.000Z"),
    assetUpdatedAt: new Date("2026-03-20T00:00:00.000Z"),
    attachmentCreatedAt: new Date("2026-03-20T00:00:00.000Z"),
    attachmentUpdatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    orgId: "company-1",
    goalId: null,
    name: "Project",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#22c55e",
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    archivedAt: null,
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

function makeProjectWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "workspace-1",
    orgId: "company-1",
    projectId: "project-1",
    name: "Workspace",
    sourceType: "local_path",
    cwd: "/tmp/project",
    repoUrl: "https://github.com/example/project.git",
    repoRef: "main",
    defaultRef: "main",
    visibility: "default",
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: null,
    isPrimary: true,
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  } as any;
}

describe("worktree merge history planner", () => {
  it("parses default scopes", () => {
    expect(parseWorktreeMergeScopes(undefined)).toEqual(["issues", "comments"]);
    expect(parseWorktreeMergeScopes("issues")).toEqual(["issues"]);
  });

  it("dedupes nested worktree issues by preserved source uuid", () => {
    const sharedIssue = makeIssue({ id: "issue-a", identifier: "PAP-10", title: "Shared" });
    const branchOneIssue = makeIssue({
      id: "issue-b",
      identifier: "PAP-22",
      title: "Branch one issue",
      createdAt: new Date("2026-03-20T01:00:00.000Z"),
    });
    const branchTwoIssue = makeIssue({
      id: "issue-c",
      identifier: "PAP-23",
      title: "Branch two issue",
      createdAt: new Date("2026-03-20T02:00:00.000Z"),
    });

    const plan = buildWorktreeMergePlan({
      orgId: "company-1",
      companyName: "Rudder",
      issuePrefix: "PAP",
      previewIssueCounterStart: 500,
      scopes: ["issues", "comments"],
      sourceIssues: [sharedIssue, branchOneIssue, branchTwoIssue],
      targetIssues: [sharedIssue, branchOneIssue],
      sourceComments: [],
      targetComments: [],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
    });

    expect(plan.counts.issuesToInsert).toBe(1);
    expect(plan.issuePlans.filter((item) => item.action === "insert").map((item) => item.source.id)).toEqual(["issue-c"]);
    expect(plan.issuePlans.find((item) => item.source.id === "issue-c" && item.action === "insert")).toMatchObject({
      previewIdentifier: "PAP-501",
    });
  });

  it("clears missing references and coerces in_progress without an assignee", () => {
    const plan = buildWorktreeMergePlan({
      orgId: "company-1",
      companyName: "Rudder",
      issuePrefix: "PAP",
      previewIssueCounterStart: 10,
      scopes: ["issues"],
      sourceIssues: [
        makeIssue({
          id: "issue-x",
          identifier: "PAP-99",
          status: "in_progress",
          assigneeAgentId: "agent-missing",
          projectId: "project-missing",
          projectWorkspaceId: "workspace-missing",
          goalId: "goal-missing",
        }),
      ],
      targetIssues: [],
      sourceComments: [],
      targetComments: [],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [],
    });

    const insert = plan.issuePlans[0] as any;
    expect(insert.targetStatus).toBe("todo");
    expect(insert.targetAssigneeAgentId).toBeNull();
    expect(insert.targetProjectId).toBeNull();
    expect(insert.targetProjectWorkspaceId).toBeNull();
    expect(insert.targetGoalId).toBeNull();
    expect(insert.adjustments).toEqual([
      "clear_assignee_agent",
      "clear_project",
      "clear_project_workspace",
      "clear_goal",
      "coerce_in_progress_to_todo",
    ]);
  });

  it("coerces imported in_review issues to todo when reviewer ownership is not imported", () => {
    const plan = buildWorktreeMergePlan({
      orgId: "company-1",
      companyName: "Rudder",
      issuePrefix: "PAP",
      previewIssueCounterStart: 10,
      scopes: ["issues"],
      sourceIssues: [makeIssue({ id: "issue-review", status: "in_review" })],
      targetIssues: [],
      sourceComments: [],
      targetComments: [],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [],
    });

    const insert = plan.issuePlans[0] as any;
    expect(insert.targetStatus).toBe("todo");
    expect(insert.adjustments).toContain("coerce_in_review_to_todo");
    expect(plan.adjustments.coerce_in_review_to_todo).toBe(1);
  });

  it("applies an explicit project mapping override instead of clearing the project", () => {
    const plan = buildWorktreeMergePlan({
      orgId: "company-1",
      companyName: "Rudder",
      issuePrefix: "PAP",
      previewIssueCounterStart: 10,
      scopes: ["issues"],
      sourceIssues: [
        makeIssue({
          id: "issue-project-map",
          identifier: "PAP-77",
          projectId: "source-project-1",
          projectWorkspaceId: "source-workspace-1",
        }),
      ],
      targetIssues: [],
      sourceComments: [],
      targetComments: [],
      targetAgents: [],
      targetProjects: [{ id: "target-project-1", name: "Mapped project", status: "in_progress" }] as any,
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
      projectIdOverrides: {
        "source-project-1": "target-project-1",
      },
    });

    const insert = plan.issuePlans[0] as any;
    expect(insert.targetProjectId).toBe("target-project-1");
    expect(insert.projectResolution).toBe("mapped");
    expect(insert.mappedProjectName).toBe("Mapped project");
    expect(insert.targetProjectWorkspaceId).toBeNull();
    expect(insert.adjustments).toEqual(["clear_project_workspace"]);
  });

  it("plans selected project imports and preserves project workspace links", () => {
    const sourceProject = makeProject({
      id: "source-project-1",
      name: "Rudder Evals",
      goalId: "goal-1",
    });
    const sourceWorkspace = makeProjectWorkspace({
      id: "source-workspace-1",
      projectId: "source-project-1",
      cwd: "/Users/dotta/rudder-evals",
      repoUrl: "https://github.com/Undertone0809/rudder-evals.git",
    });

    const plan = buildWorktreeMergePlan({
      orgId: "company-1",
      companyName: "Rudder",
      issuePrefix: "PAP",
      previewIssueCounterStart: 10,
      scopes: ["issues"],
      sourceIssues: [
        makeIssue({
          id: "issue-project-import",
          identifier: "PAP-88",
          projectId: "source-project-1",
          projectWorkspaceId: "source-workspace-1",
        }),
      ],
      targetIssues: [],
      sourceComments: [],
      targetComments: [],
      sourceProjects: [sourceProject],
      sourceProjectWorkspaces: [sourceWorkspace],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
      importProjectIds: ["source-project-1"],
    });

    expect(plan.counts.projectsToImport).toBe(1);
    expect(plan.projectImports[0]).toMatchObject({
      source: { id: "source-project-1", name: "Rudder Evals" },
      targetGoalId: "goal-1",
      workspaces: [{ id: "source-workspace-1" }],
    });

    const insert = plan.issuePlans[0] as any;
    expect(insert.targetProjectId).toBe("source-project-1");
    expect(insert.targetProjectWorkspaceId).toBe("source-workspace-1");
    expect(insert.projectResolution).toBe("imported");
    expect(insert.mappedProjectName).toBe("Rudder Evals");
    expect(insert.adjustments).toEqual([]);
  });

  it("imports comments onto shared or newly imported issues while skipping existing comments", () => {
    const sharedIssue = makeIssue({ id: "issue-a", identifier: "PAP-10" });
    const newIssue = makeIssue({
      id: "issue-b",
      identifier: "PAP-11",
      createdAt: new Date("2026-03-20T01:00:00.000Z"),
    });
    const existingComment = makeComment({ id: "comment-existing", issueId: "issue-a" });
    const sharedIssueComment = makeComment({ id: "comment-shared", issueId: "issue-a" });
    const newIssueComment = makeComment({
      id: "comment-new-issue",
      issueId: "issue-b",
      authorAgentId: "missing-agent",
      createdAt: new Date("2026-03-20T01:05:00.000Z"),
    });

    const plan = buildWorktreeMergePlan({
      orgId: "company-1",
      companyName: "Rudder",
      issuePrefix: "PAP",
      previewIssueCounterStart: 10,
      scopes: ["issues", "comments"],
      sourceIssues: [sharedIssue, newIssue],
      targetIssues: [sharedIssue],
      sourceComments: [existingComment, sharedIssueComment, newIssueComment],
      targetComments: [existingComment],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
    });

    expect(plan.counts.commentsToInsert).toBe(2);
    expect(plan.counts.commentsExisting).toBe(1);
    expect(plan.commentPlans.filter((item) => item.action === "insert").map((item) => item.source.id)).toEqual([
      "comment-shared",
      "comment-new-issue",
    ]);
    expect(plan.adjustments.clear_author_agent).toBe(1);
  });

  it("merges document revisions onto an existing shared document and renumbers conflicts", () => {
    const sharedIssue = makeIssue({ id: "issue-a", identifier: "PAP-10" });
    const sourceDocument = makeIssueDocument({
      issueId: "issue-a",
      documentId: "document-a",
      latestBody: "# Branch plan",
      latestRevisionId: "revision-branch-2",
      latestRevisionNumber: 2,
      documentUpdatedAt: new Date("2026-03-20T02:00:00.000Z"),
      linkUpdatedAt: new Date("2026-03-20T02:00:00.000Z"),
    });
    const targetDocument = makeIssueDocument({
      issueId: "issue-a",
      documentId: "document-a",
      latestBody: "# Main plan",
      latestRevisionId: "revision-main-2",
      latestRevisionNumber: 2,
      documentUpdatedAt: new Date("2026-03-20T01:00:00.000Z"),
      linkUpdatedAt: new Date("2026-03-20T01:00:00.000Z"),
    });
    const sourceRevisionOne = makeDocumentRevision({ documentId: "document-a", id: "revision-1" });
    const sourceRevisionTwo = makeDocumentRevision({
      documentId: "document-a",
      id: "revision-branch-2",
      revisionNumber: 2,
      body: "# Branch plan",
      createdAt: new Date("2026-03-20T02:00:00.000Z"),
    });
    const targetRevisionOne = makeDocumentRevision({ documentId: "document-a", id: "revision-1" });
    const targetRevisionTwo = makeDocumentRevision({
      documentId: "document-a",
      id: "revision-main-2",
      revisionNumber: 2,
      body: "# Main plan",
      createdAt: new Date("2026-03-20T01:00:00.000Z"),
    });

    const plan = buildWorktreeMergePlan({
      orgId: "company-1",
      companyName: "Rudder",
      issuePrefix: "PAP",
      previewIssueCounterStart: 10,
      scopes: ["issues", "comments"],
      sourceIssues: [sharedIssue],
      targetIssues: [sharedIssue],
      sourceComments: [],
      targetComments: [],
      sourceDocuments: [sourceDocument],
      targetDocuments: [targetDocument],
      sourceDocumentRevisions: [sourceRevisionOne, sourceRevisionTwo],
      targetDocumentRevisions: [targetRevisionOne, targetRevisionTwo],
      sourceAttachments: [],
      targetAttachments: [],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
    });

    expect(plan.counts.documentsToMerge).toBe(1);
    expect(plan.counts.documentRevisionsToInsert).toBe(1);
    expect(plan.documentPlans[0]).toMatchObject({
      action: "merge_existing",
      latestRevisionId: "revision-branch-2",
      latestRevisionNumber: 3,
    });
    const mergePlan = plan.documentPlans[0] as any;
    expect(mergePlan.revisionsToInsert).toHaveLength(1);
    expect(mergePlan.revisionsToInsert[0]).toMatchObject({
      source: { id: "revision-branch-2" },
      targetRevisionNumber: 3,
    });
  });

  it("imports attachments while clearing missing comment and author references", () => {
    const sharedIssue = makeIssue({ id: "issue-a", identifier: "PAP-10" });
    const attachment = makeAttachment({
      issueId: "issue-a",
      issueCommentId: "comment-missing",
      createdByAgentId: "agent-missing",
    });

    const plan = buildWorktreeMergePlan({
      orgId: "company-1",
      companyName: "Rudder",
      issuePrefix: "PAP",
      previewIssueCounterStart: 10,
      scopes: ["issues"],
      sourceIssues: [sharedIssue],
      targetIssues: [sharedIssue],
      sourceComments: [],
      targetComments: [],
      sourceDocuments: [],
      targetDocuments: [],
      sourceDocumentRevisions: [],
      targetDocumentRevisions: [],
      sourceAttachments: [attachment],
      targetAttachments: [],
      targetAgents: [],
      targetProjects: [],
      targetProjectWorkspaces: [],
      targetGoals: [{ id: "goal-1" }] as any,
    });

    expect(plan.counts.attachmentsToInsert).toBe(1);
    expect(plan.adjustments.clear_attachment_agent).toBe(1);
    expect(plan.attachmentPlans[0]).toMatchObject({
      action: "insert",
      targetIssueCommentId: null,
      targetCreatedByAgentId: null,
    });
  });
});

describe("worktree merge Goal persistence", () => {
  let testRoot = "";
  let postgresInstance: EmbeddedPostgres | undefined;
  let postgresStarted = false;
  let testDb: ReturnType<typeof createDb> | undefined;

  beforeAll(async () => {
    testRoot = mkdtempSync(path.join(os.tmpdir(), "rudder-worktree-merge-"));
    const port = await availablePostgresPort();
    postgresInstance = new EmbeddedPostgres({
      databaseDir: path.join(testRoot, "postgres"),
      user: "rudder",
      password: "rudder",
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      onLog: () => {},
      onError: () => {},
    });
    await postgresInstance.initialise();
    await postgresInstance.start();
    postgresStarted = true;

    const adminUrl = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminUrl, "rudder");
    testDb = createDb(`postgres://rudder:rudder@127.0.0.1:${port}/rudder`);
    for (const statement of worktreeMergeTestSchema) {
      await testDb.execute(sql.raw(statement));
    }
  }, 120_000);

  afterAll(async () => {
    await testDb?.$client.end({ timeout: 5 });
    if (postgresStarted) await postgresInstance?.stop();
    if (testRoot) rmSync(testRoot, { recursive: true, force: true });
  });

  async function seedGoalImport(owner?: "rust") {
    if (!testDb) throw new Error("Test database did not start");
    const orgId = randomUUID();
    const projectId = randomUUID();
    const goalId = randomUUID();
    await testDb.$client.unsafe(
      `INSERT INTO organizations (id, url_key, name, issue_prefix)
       VALUES ($1::uuid, $2, 'Worktree Merge Test', $3)`,
      [orgId, orgId, `WT${orgId.slice(0, 5)}`],
    );
    await testDb.$client.unsafe(
      "INSERT INTO goals (id, org_id, title) VALUES ($1::uuid, $2::uuid, 'Imported Goal')",
      [goalId, orgId],
    );
    await testDb.execute(sql`
      INSERT INTO organization_mutation_state (org_id)
      VALUES (${orgId}::uuid)
    `);
    if (owner) {
      await testDb.execute(sql`
        INSERT INTO project_goal_owner_seed (project_id, owner)
        VALUES (${projectId}::uuid, ${owner})
      `);
    }
    return { orgId, projectId, goalId };
  }

  async function applyGoalImport(input: { orgId: string; projectId: string; goalId: string }) {
    if (!testDb) throw new Error("Test database did not start");
    return await applyMergePlan({
      sourceStorages: [],
      targetStorage: {} as never,
      targetDb: testDb as never,
      company: { id: input.orgId, name: "Worktree Merge Test", issuePrefix: "WT" },
      plan: makeGoalImportPlan(input.orgId, input.projectId, input.goalId),
    });
  }

  it("reads back matching legacy and canonical Goal links after an import", async () => {
    if (!testDb) throw new Error("Test database did not start");
    const identity = await seedGoalImport();

    const result = await applyGoalImport(identity);

    expect(result.insertedProjects).toBe(1);
    const projectRows = await testDb
      .select({ goalId: projects.goalId })
      .from(projects)
      .where(eq(projects.id, identity.projectId));
    const canonicalLinks = await testDb
      .select({ orgId: projectGoals.orgId, goalId: projectGoals.goalId })
      .from(projectGoals)
      .where(eq(projectGoals.projectId, identity.projectId));
    expect(projectRows).toEqual([{ goalId: identity.goalId }]);
    expect(canonicalLinks).toEqual([{ orgId: identity.orgId, goalId: identity.goalId }]);

    const [authority] = await testDb.$client.unsafe(
      `SELECT owner, mutation_version::text AS mutation_version,
              fence_epoch::text AS fence_epoch
       FROM project_goal_mutation_state WHERE project_id = $1::uuid`,
      [identity.projectId],
    );
    expect(authority).toMatchObject({
      owner: "node",
      mutation_version: "0",
      fence_epoch: "0",
    });
  });

  it("rejects Rust-owned project Goal authority and rolls back the import", async () => {
    if (!testDb) throw new Error("Test database did not start");
    const identity = await seedGoalImport("rust");

    await expect(applyGoalImport(identity)).rejects.toThrow(
      "Project goal mutation authority is owned by Rust",
    );

    const projectRows = await testDb
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, identity.projectId));
    const canonicalLinks = await testDb
      .select({ projectId: projectGoals.projectId })
      .from(projectGoals)
      .where(eq(projectGoals.projectId, identity.projectId));
    const ownerRows = await testDb.$client.unsafe(
      "SELECT project_id FROM project_goal_mutation_state WHERE project_id = $1::uuid",
      [identity.projectId],
    );
    expect(projectRows).toEqual([]);
    expect(canonicalLinks).toEqual([]);
    expect(ownerRows).toEqual([]);

    const [organizationAuthority] = await testDb.$client.unsafe(
      `SELECT owner, mutation_version::text AS mutation_version,
              fence_epoch::text AS fence_epoch
       FROM organization_mutation_state WHERE org_id = $1::uuid`,
      [identity.orgId],
    );
    expect(organizationAuthority).toMatchObject({
      owner: "node",
      mutation_version: "0",
      fence_epoch: "0",
    });
  });
});
