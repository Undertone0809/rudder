import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  promises as fsPromises,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { Readable } from "node:stream";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  agents,
  assets,
  organizations,
  createDb,
  documentRevisions,
  documents,
  ensurePostgresDatabase,
  formatDatabaseBackupResult,
  goals,
  heartbeatRuns,
  inspectMigrations,
  issueAttachments,
  issueComments,
  issueDocuments,
  issues,
  projectWorkspaces,
  projects,
  runDatabaseBackup,
  runDatabaseRestore,
} from "@rudderhq/db";
import type { Command } from "commander";
import { ensureAgentJwtSecret, loadRudderEnvFile, mergePaperclipEnvEntries, readPaperclipEnvEntries, resolvePaperclipEnvFile } from "../config/env.js";
import { expandHomePrefix } from "../config/home.js";
import type { RudderConfig } from "../config/schema.js";
import { readConfig, resolveConfigPath, writeConfig } from "../config/store.js";
import { printRudderCliBanner } from "../utils/banner.js";
import { resolveRuntimeLikePath } from "../utils/path-resolver.js";
import {
  buildWorktreeConfig,
  buildWorktreeEnvEntries,
  DEFAULT_WORKTREE_HOME,
  formatShellExports,
  generateWorktreeColor,
  isWorktreeSeedMode,
  resolveSuggestedWorktreeName,
  resolveWorktreeSeedPlan,
  resolveWorktreeLocalPaths,
  sanitizeWorktreeInstanceId,
  type WorktreeSeedMode,
  type WorktreeLocalPaths,
} from "./worktree-lib.js";
import {
  buildWorktreeMergePlan,
  parseWorktreeMergeScopes,
  type IssueAttachmentRow,
  type IssueDocumentRow,
  type DocumentRevisionRow,
  type PlannedAttachmentInsert,
  type PlannedCommentInsert,
  type PlannedIssueDocumentInsert,
  type PlannedIssueDocumentMerge,
  type PlannedIssueInsert,
} from "./worktree-merge-history-lib.js";
import type {
  WorktreeListOptions,
  WorktreeMergeHistoryOptions,
} from "./worktree-types.js";
import { nonEmpty, isCurrentSourceConfigPath, WORKTREE_NAME_PREFIX, resolveWorktreeMakeName, resolveWorktreeHome, resolveWorktreeStartPoint, ConfiguredStorage, assertStorageCompanyPrefix, normalizeStorageObjectKey, resolveLocalStoragePath, s3BodyToBuffer, normalizeS3Prefix, buildS3ObjectKey, dynamicImport, createConfiguredStorageFromRudderConfig, openConfiguredStorage, streamToBuffer, isMissingStorageObjectError, readSourceAttachmentBody, resolveWorktreeMakeTargetPath, extractExecSyncErrorMessage, localBranchExists, resolveGitWorktreeAddArgs, readPidFilePort, readRunningPostmasterPid, isPortAvailable, findAvailablePort, detectGitBranchName, detectGitWorkspaceInfo, copyDirectoryContents, copyGitHooksToWorktreeGitDir, rebindWorkspaceCwd, rebindSeededProjectWorkspaces, resolveSourceConfigPath, resolveSourceConnectionString, copySeededSecretsKey, ensureEmbeddedPostgres, seedWorktreeDatabase, runWorktreeInit, worktreeInitCommand, worktreeMakeCommand } from "./worktree-init.js";
import { WorktreeCleanupOptions, GitWorktreeListEntry, MergeSourceChoice, ResolvedWorktreeEndpoint, parseGitWorktreeList, toMergeSourceChoices, branchHasUniqueCommits, branchExistsOnAnyRemote, worktreePathHasUncommittedChanges, worktreeCleanupCommand, worktreeEnvCommand, ClosableDb, OpenDbHandle, ResolvedMergeCompany, closeDb, resolveCurrentEndpoint, resolveAttachmentLookupStorages, openConfiguredDb } from "./worktree-cleanup.js";

export async function resolveMergeCompany(input: {
  sourceDb: ClosableDb;
  targetDb: ClosableDb;
  selector?: string;
}): Promise<ResolvedMergeCompany> {
  const [sourceCompanies, targetCompanies] = await Promise.all([
    input.sourceDb
      .select({
        id: organizations.id,
        name: organizations.name,
        issuePrefix: organizations.issuePrefix,
      })
      .from(organizations),
    input.targetDb
      .select({
        id: organizations.id,
        name: organizations.name,
        issuePrefix: organizations.issuePrefix,
      })
      .from(organizations),
  ]);

  const targetById = new Map(targetCompanies.map((company) => [company.id, company]));
  const shared = sourceCompanies.filter((company) => targetById.has(company.id));
  const selector = nonEmpty(input.selector);
  if (selector) {
    const matched = shared.find(
      (company) => company.id === selector || company.issuePrefix.toLowerCase() === selector.toLowerCase(),
    );
    if (!matched) {
      throw new Error(`Could not resolve company "${selector}" in both source and target databases.`);
    }
    return matched;
  }

  if (shared.length === 1) {
    return shared[0];
  }

  if (shared.length === 0) {
    throw new Error("Source and target databases do not share a company id. Pass --company explicitly once both sides match.");
  }

  const options = shared
    .map((company) => `${company.issuePrefix} (${company.name})`)
    .join(", ");
  throw new Error(`Multiple shared organizations found. Re-run with --company <id-or-prefix>. Options: ${options}`);
}

export function renderMergePlan(plan: Awaited<ReturnType<typeof collectMergePlan>>["plan"], extras: {
  sourcePath: string;
  targetPath: string;
  unsupportedRunCount: number;
}): string {
  const terminalWidth = Math.max(60, process.stdout.columns ?? 100);
  const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
  const truncateToWidth = (value: string, maxWidth: number) => {
    if (maxWidth <= 1) return "";
    if (value.length <= maxWidth) return value;
    return `${value.slice(0, Math.max(0, maxWidth - 1)).trimEnd()}…`;
  };
  const lines = [
    `Mode: preview`,
    `Source: ${extras.sourcePath}`,
    `Target: ${extras.targetPath}`,
    `Organization: ${plan.companyName} (${plan.issuePrefix})`,
    "",
    "Projects",
    `- import: ${plan.counts.projectsToImport}`,
    "",
    "Issues",
    `- insert: ${plan.counts.issuesToInsert}`,
    `- already present: ${plan.counts.issuesExisting}`,
    `- shared/imported issues with drift: ${plan.counts.issueDrift}`,
  ];

  if (plan.projectImports.length > 0) {
    lines.push("");
    lines.push("Planned project imports");
    for (const project of plan.projectImports) {
      lines.push(
        `- ${project.source.name} (${project.workspaces.length} workspace${project.workspaces.length === 1 ? "" : "s"})`,
      );
    }
  }

  const issueInserts = plan.issuePlans.filter((item): item is PlannedIssueInsert => item.action === "insert");
  if (issueInserts.length > 0) {
    lines.push("");
    lines.push("Planned issue imports");
    for (const issue of issueInserts) {
      const projectNote =
        (issue.projectResolution === "mapped" || issue.projectResolution === "imported")
        && issue.mappedProjectName
          ? ` project->${issue.projectResolution === "imported" ? "import:" : ""}${issue.mappedProjectName}`
          : "";
      const adjustments = issue.adjustments.length > 0 ? ` [${issue.adjustments.join(", ")}]` : "";
      const prefix = `- ${issue.source.identifier ?? issue.source.id} -> ${issue.previewIdentifier} (${issue.targetStatus}${projectNote})`;
      const title = oneLine(issue.source.title);
      const suffix = `${adjustments}${title ? ` ${title}` : ""}`;
      lines.push(
        `${prefix}${truncateToWidth(suffix, Math.max(8, terminalWidth - prefix.length))}`,
      );
    }
  }

  if (plan.scopes.includes("comments")) {
    lines.push("");
    lines.push("Comments");
    lines.push(`- insert: ${plan.counts.commentsToInsert}`);
    lines.push(`- already present: ${plan.counts.commentsExisting}`);
    lines.push(`- skipped (missing parent): ${plan.counts.commentsMissingParent}`);
  }

  lines.push("");
  lines.push("Documents");
  lines.push(`- insert: ${plan.counts.documentsToInsert}`);
  lines.push(`- merge existing: ${plan.counts.documentsToMerge}`);
  lines.push(`- already present: ${plan.counts.documentsExisting}`);
  lines.push(`- skipped (conflicting key): ${plan.counts.documentsConflictingKey}`);
  lines.push(`- skipped (missing parent): ${plan.counts.documentsMissingParent}`);
  lines.push(`- revisions insert: ${plan.counts.documentRevisionsToInsert}`);

  lines.push("");
  lines.push("Attachments");
  lines.push(`- insert: ${plan.counts.attachmentsToInsert}`);
  lines.push(`- already present: ${plan.counts.attachmentsExisting}`);
  lines.push(`- skipped (missing parent): ${plan.counts.attachmentsMissingParent}`);

  lines.push("");
  lines.push("Adjustments");
  lines.push(`- cleared assignee agents: ${plan.adjustments.clear_assignee_agent}`);
  lines.push(`- cleared projects: ${plan.adjustments.clear_project}`);
  lines.push(`- cleared project workspaces: ${plan.adjustments.clear_project_workspace}`);
  lines.push(`- cleared goals: ${plan.adjustments.clear_goal}`);
  lines.push(`- cleared comment author agents: ${plan.adjustments.clear_author_agent}`);
  lines.push(`- cleared document agents: ${plan.adjustments.clear_document_agent}`);
  lines.push(`- cleared document revision agents: ${plan.adjustments.clear_document_revision_agent}`);
  lines.push(`- cleared attachment author agents: ${plan.adjustments.clear_attachment_agent}`);
  lines.push(`- coerced in_progress to todo: ${plan.adjustments.coerce_in_progress_to_todo}`);

  lines.push("");
  lines.push("Not imported in this phase");
  lines.push(`- heartbeat runs: ${extras.unsupportedRunCount}`);
  lines.push("");
  lines.push("Identifiers shown above are provisional preview values. `--apply` reserves fresh issue numbers at write time.");

  return lines.join("\n");
}

export async function collectMergePlan(input: {
  sourceDb: ClosableDb;
  targetDb: ClosableDb;
  company: ResolvedMergeCompany;
  scopes: ReturnType<typeof parseWorktreeMergeScopes>;
  importProjectIds?: Iterable<string>;
  projectIdOverrides?: Record<string, string | null | undefined>;
}) {
  const orgId = input.company.id;
  const [
    targetCompanyRow,
    sourceIssuesRows,
    targetIssuesRows,
    sourceCommentsRows,
    targetCommentsRows,
    sourceIssueDocumentsRows,
    targetIssueDocumentsRows,
    sourceDocumentRevisionRows,
    targetDocumentRevisionRows,
    sourceAttachmentRows,
    targetAttachmentRows,
    sourceProjectsRows,
    sourceProjectWorkspaceRows,
    targetProjectsRows,
    targetAgentsRows,
    targetProjectWorkspaceRows,
    targetGoalsRows,
    runCountRows,
  ] = await Promise.all([
    input.targetDb
      .select({
        issueCounter: organizations.issueCounter,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .then((rows) => rows[0] ?? null),
    input.sourceDb
      .select()
      .from(issues)
      .where(eq(issues.orgId, orgId)),
    input.targetDb
      .select()
      .from(issues)
      .where(eq(issues.orgId, orgId)),
    input.scopes.includes("comments")
      ? input.sourceDb
        .select()
        .from(issueComments)
        .where(eq(issueComments.orgId, orgId))
      : Promise.resolve([]),
    input.targetDb
      .select()
      .from(issueComments)
      .where(eq(issueComments.orgId, orgId)),
    input.sourceDb
      .select({
        id: issueDocuments.id,
        orgId: issueDocuments.orgId,
        issueId: issueDocuments.issueId,
        documentId: issueDocuments.documentId,
        key: issueDocuments.key,
        linkCreatedAt: issueDocuments.createdAt,
        linkUpdatedAt: issueDocuments.updatedAt,
        title: documents.title,
        format: documents.format,
        latestBody: documents.latestBody,
        latestRevisionId: documents.latestRevisionId,
        latestRevisionNumber: documents.latestRevisionNumber,
        createdByAgentId: documents.createdByAgentId,
        createdByUserId: documents.createdByUserId,
        updatedByAgentId: documents.updatedByAgentId,
        updatedByUserId: documents.updatedByUserId,
        documentCreatedAt: documents.createdAt,
        documentUpdatedAt: documents.updatedAt,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .innerJoin(issues, eq(issueDocuments.issueId, issues.id))
      .where(eq(issues.orgId, orgId)),
    input.targetDb
      .select({
        id: issueDocuments.id,
        orgId: issueDocuments.orgId,
        issueId: issueDocuments.issueId,
        documentId: issueDocuments.documentId,
        key: issueDocuments.key,
        linkCreatedAt: issueDocuments.createdAt,
        linkUpdatedAt: issueDocuments.updatedAt,
        title: documents.title,
        format: documents.format,
        latestBody: documents.latestBody,
        latestRevisionId: documents.latestRevisionId,
        latestRevisionNumber: documents.latestRevisionNumber,
        createdByAgentId: documents.createdByAgentId,
        createdByUserId: documents.createdByUserId,
        updatedByAgentId: documents.updatedByAgentId,
        updatedByUserId: documents.updatedByUserId,
        documentCreatedAt: documents.createdAt,
        documentUpdatedAt: documents.updatedAt,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .innerJoin(issues, eq(issueDocuments.issueId, issues.id))
      .where(eq(issues.orgId, orgId)),
    input.sourceDb
      .select({
        id: documentRevisions.id,
        orgId: documentRevisions.orgId,
        documentId: documentRevisions.documentId,
        revisionNumber: documentRevisions.revisionNumber,
        body: documentRevisions.body,
        changeSummary: documentRevisions.changeSummary,
        createdByAgentId: documentRevisions.createdByAgentId,
        createdByUserId: documentRevisions.createdByUserId,
        createdAt: documentRevisions.createdAt,
      })
      .from(documentRevisions)
      .innerJoin(issueDocuments, eq(documentRevisions.documentId, issueDocuments.documentId))
      .innerJoin(issues, eq(issueDocuments.issueId, issues.id))
      .where(eq(issues.orgId, orgId)),
    input.targetDb
      .select({
        id: documentRevisions.id,
        orgId: documentRevisions.orgId,
        documentId: documentRevisions.documentId,
        revisionNumber: documentRevisions.revisionNumber,
        body: documentRevisions.body,
        changeSummary: documentRevisions.changeSummary,
        createdByAgentId: documentRevisions.createdByAgentId,
        createdByUserId: documentRevisions.createdByUserId,
        createdAt: documentRevisions.createdAt,
      })
      .from(documentRevisions)
      .innerJoin(issueDocuments, eq(documentRevisions.documentId, issueDocuments.documentId))
      .innerJoin(issues, eq(issueDocuments.issueId, issues.id))
      .where(eq(issues.orgId, orgId)),
    input.sourceDb
      .select({
        id: issueAttachments.id,
        orgId: issueAttachments.orgId,
        issueId: issueAttachments.issueId,
        issueCommentId: issueAttachments.issueCommentId,
        assetId: issueAttachments.assetId,
        provider: assets.provider,
        objectKey: assets.objectKey,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        sha256: assets.sha256,
        originalFilename: assets.originalFilename,
        createdByAgentId: assets.createdByAgentId,
        createdByUserId: assets.createdByUserId,
        assetCreatedAt: assets.createdAt,
        assetUpdatedAt: assets.updatedAt,
        attachmentCreatedAt: issueAttachments.createdAt,
        attachmentUpdatedAt: issueAttachments.updatedAt,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
      .innerJoin(issues, eq(issueAttachments.issueId, issues.id))
      .where(eq(issues.orgId, orgId)),
    input.targetDb
      .select({
        id: issueAttachments.id,
        orgId: issueAttachments.orgId,
        issueId: issueAttachments.issueId,
        issueCommentId: issueAttachments.issueCommentId,
        assetId: issueAttachments.assetId,
        provider: assets.provider,
        objectKey: assets.objectKey,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        sha256: assets.sha256,
        originalFilename: assets.originalFilename,
        createdByAgentId: assets.createdByAgentId,
        createdByUserId: assets.createdByUserId,
        assetCreatedAt: assets.createdAt,
        assetUpdatedAt: assets.updatedAt,
        attachmentCreatedAt: issueAttachments.createdAt,
        attachmentUpdatedAt: issueAttachments.updatedAt,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
      .innerJoin(issues, eq(issueAttachments.issueId, issues.id))
      .where(eq(issues.orgId, orgId)),
    input.sourceDb
      .select()
      .from(projects)
      .where(eq(projects.orgId, orgId)),
    input.sourceDb
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.orgId, orgId)),
    input.targetDb
      .select()
      .from(projects)
      .where(eq(projects.orgId, orgId)),
    input.targetDb
      .select()
      .from(agents)
      .where(eq(agents.orgId, orgId)),
    input.targetDb
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.orgId, orgId)),
    input.targetDb
      .select()
      .from(goals)
      .where(eq(goals.orgId, orgId)),
    input.sourceDb
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.orgId, orgId)),
  ]);

  if (!targetCompanyRow) {
    throw new Error(`Target company ${orgId} was not found.`);
  }

  const plan = buildWorktreeMergePlan({
    orgId,
    companyName: input.company.name,
    issuePrefix: input.company.issuePrefix,
    previewIssueCounterStart: targetCompanyRow.issueCounter,
    scopes: input.scopes,
    sourceIssues: sourceIssuesRows,
    targetIssues: targetIssuesRows,
    sourceComments: sourceCommentsRows,
    targetComments: targetCommentsRows,
    sourceProjects: sourceProjectsRows,
    sourceProjectWorkspaces: sourceProjectWorkspaceRows,
    sourceDocuments: sourceIssueDocumentsRows as IssueDocumentRow[],
    targetDocuments: targetIssueDocumentsRows as IssueDocumentRow[],
    sourceDocumentRevisions: sourceDocumentRevisionRows as DocumentRevisionRow[],
    targetDocumentRevisions: targetDocumentRevisionRows as DocumentRevisionRow[],
    sourceAttachments: sourceAttachmentRows as IssueAttachmentRow[],
    targetAttachments: targetAttachmentRows as IssueAttachmentRow[],
    targetAgents: targetAgentsRows,
    targetProjects: targetProjectsRows,
    targetProjectWorkspaces: targetProjectWorkspaceRows,
    targetGoals: targetGoalsRows,
    importProjectIds: input.importProjectIds,
    projectIdOverrides: input.projectIdOverrides,
  });

  return {
    plan,
    sourceProjects: sourceProjectsRows,
    targetProjects: targetProjectsRows,
    unsupportedRunCount: runCountRows[0]?.count ?? 0,
  };
}

export type ProjectMappingSelections = {
  importProjectIds: string[];
  projectIdOverrides: Record<string, string | null>;
};

export async function promptForProjectMappings(input: {
  plan: Awaited<ReturnType<typeof collectMergePlan>>["plan"];
  sourceProjects: Awaited<ReturnType<typeof collectMergePlan>>["sourceProjects"];
  targetProjects: Awaited<ReturnType<typeof collectMergePlan>>["targetProjects"];
}): Promise<ProjectMappingSelections> {
  const missingProjectIds = [
    ...new Set(
      input.plan.issuePlans
        .filter((plan): plan is PlannedIssueInsert => plan.action === "insert")
        .filter((plan) => !!plan.source.projectId && plan.projectResolution === "cleared")
        .map((plan) => plan.source.projectId as string),
    ),
  ];
  if (missingProjectIds.length === 0) {
    return {
      importProjectIds: [],
      projectIdOverrides: {},
    };
  }

  const sourceProjectsById = new Map(input.sourceProjects.map((project) => [project.id, project]));
  const targetChoices = [...input.targetProjects]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((project) => ({
      value: project.id,
      label: project.name,
      hint: project.status,
    }));

  const mappings: Record<string, string | null> = {};
  const importProjectIds = new Set<string>();
  for (const sourceProjectId of missingProjectIds) {
    const sourceProject = sourceProjectsById.get(sourceProjectId);
    if (!sourceProject) continue;
    const nameMatch = input.targetProjects.find(
      (project) => project.name.trim().toLowerCase() === sourceProject.name.trim().toLowerCase(),
    );
    const importSelectionValue = `__import__:${sourceProjectId}`;
    const selection = await p.select<string | null>({
      message: `Project "${sourceProject.name}" is missing in target. How should ${input.plan.issuePrefix} imports handle it?`,
      options: [
        {
          value: importSelectionValue,
          label: `Import ${sourceProject.name}`,
          hint: "Create the project and copy its workspace settings",
        },
        ...(nameMatch
          ? [{
              value: nameMatch.id,
              label: `Map to ${nameMatch.name}`,
              hint: "Recommended: exact name match",
            }]
          : []),
        {
          value: null,
          label: "Leave unset",
          hint: "Keep imported issues without a project",
        },
        ...targetChoices.filter((choice) => choice.value !== nameMatch?.id),
      ],
      initialValue: nameMatch?.id ?? null,
    });
    if (p.isCancel(selection)) {
      throw new Error("Project mapping cancelled.");
    }
    if (selection === importSelectionValue) {
      importProjectIds.add(sourceProjectId);
      continue;
    }
    mappings[sourceProjectId] = selection;
  }

  return {
    importProjectIds: [...importProjectIds],
    projectIdOverrides: mappings,
  };
}

export async function worktreeListCommand(opts: WorktreeListOptions): Promise<void> {
  const choices = toMergeSourceChoices(process.cwd());
  if (opts.json) {
    console.log(JSON.stringify(choices, null, 2));
    return;
  }

  for (const choice of choices) {
    const flags = [
      choice.isCurrent ? "current" : null,
      choice.hasRudderConfig ? "rudder" : "no-rudder-config",
    ].filter((value): value is string => value !== null);
    p.log.message(`${choice.branchLabel}  ${choice.worktree}  [${flags.join(", ")}]`);
  }
}

export function resolveEndpointFromChoice(choice: MergeSourceChoice): ResolvedWorktreeEndpoint {
  if (choice.isCurrent) {
    return resolveCurrentEndpoint();
  }
  return {
    rootPath: choice.worktree,
    configPath: path.resolve(choice.worktree, ".rudder", "config.json"),
    label: choice.branchLabel,
    isCurrent: false,
  };
}

export function resolveWorktreeEndpointFromSelector(
  selector: string,
  opts?: { allowCurrent?: boolean },
): ResolvedWorktreeEndpoint {
  const trimmed = selector.trim();
  const allowCurrent = opts?.allowCurrent !== false;
  if (trimmed.length === 0) {
    throw new Error("Worktree selector cannot be empty.");
  }

  const currentEndpoint = resolveCurrentEndpoint();
  if (allowCurrent && trimmed === "current") {
    return currentEndpoint;
  }

  const choices = toMergeSourceChoices(process.cwd());
  const directPath = path.resolve(trimmed);
  if (existsSync(directPath)) {
    if (allowCurrent && directPath === currentEndpoint.rootPath) {
      return currentEndpoint;
    }
    const configPath = path.resolve(directPath, ".rudder", "config.json");
    if (!existsSync(configPath)) {
      throw new Error(`Resolved worktree path ${directPath} does not contain .rudder/config.json.`);
    }
    return {
      rootPath: directPath,
      configPath,
      label: path.basename(directPath),
      isCurrent: false,
    };
  }

  const matched = choices.find((choice) =>
    (allowCurrent || !choice.isCurrent)
    && (choice.worktree === directPath
      || path.basename(choice.worktree) === trimmed
      || choice.branchLabel === trimmed),
  );
  if (!matched) {
    throw new Error(
      `Could not resolve worktree "${selector}". Use a path, a listed worktree directory name, branch name, or "current".`,
    );
  }
  if (!matched.hasRudderConfig && !matched.isCurrent) {
    throw new Error(`Resolved worktree "${selector}" does not look like a Rudder worktree.`);
  }
  return resolveEndpointFromChoice(matched);
}

export async function promptForSourceEndpoint(excludeWorktreePath?: string): Promise<ResolvedWorktreeEndpoint> {
  const excluded = excludeWorktreePath ? path.resolve(excludeWorktreePath) : null;
  const currentEndpoint = resolveCurrentEndpoint();
  const choices = toMergeSourceChoices(process.cwd())
    .filter((choice) => choice.hasRudderConfig || choice.isCurrent)
    .filter((choice) => path.resolve(choice.worktree) !== excluded)
    .map((choice) => ({
      value: choice.isCurrent ? "__current__" : choice.worktree,
      label: choice.branchLabel,
      hint: `${choice.worktree}${choice.isCurrent ? " (current)" : ""}`,
    }));
  if (choices.length === 0) {
    throw new Error("No Rudder worktrees were found. Run `rudder worktree:list` to inspect the repo worktrees.");
  }
  const selection = await p.select<string>({
    message: "Choose the source worktree to import from",
    options: choices,
  });
  if (p.isCancel(selection)) {
    throw new Error("Source worktree selection cancelled.");
  }
  if (selection === "__current__") {
    return currentEndpoint;
  }
  return resolveWorktreeEndpointFromSelector(selection, { allowCurrent: true });
}

export async function applyMergePlan(input: {
  sourceStorages: ConfiguredStorage[];
  targetStorage: ConfiguredStorage;
  targetDb: ClosableDb;
  company: ResolvedMergeCompany;
  plan: Awaited<ReturnType<typeof collectMergePlan>>["plan"];
}) {
  const orgId = input.company.id;

  return await input.targetDb.transaction(async (tx) => {
    const importedProjectIds = input.plan.projectImports.map((project) => project.source.id);
    const existingImportedProjectIds = importedProjectIds.length > 0
      ? new Set(
        (await tx
          .select({ id: projects.id })
          .from(projects)
          .where(inArray(projects.id, importedProjectIds)))
          .map((row) => row.id),
      )
      : new Set<string>();
    const projectImports = input.plan.projectImports.filter((project) => !existingImportedProjectIds.has(project.source.id));
    const importedWorkspaceIds = projectImports.flatMap((project) => project.workspaces.map((workspace) => workspace.id));
    const existingImportedWorkspaceIds = importedWorkspaceIds.length > 0
      ? new Set(
        (await tx
          .select({ id: projectWorkspaces.id })
          .from(projectWorkspaces)
          .where(inArray(projectWorkspaces.id, importedWorkspaceIds)))
          .map((row) => row.id),
      )
      : new Set<string>();

    let insertedProjects = 0;
    let insertedProjectWorkspaces = 0;
    for (const project of projectImports) {
      await tx.insert(projects).values({
        id: project.source.id,
        orgId,
        goalId: project.targetGoalId,
        name: project.source.name,
        description: project.source.description,
        status: project.source.status,
        leadAgentId: project.targetLeadAgentId,
        targetDate: project.source.targetDate,
        color: project.source.color,
        pauseReason: project.source.pauseReason,
        pausedAt: project.source.pausedAt,
        executionWorkspacePolicy: project.source.executionWorkspacePolicy,
        archivedAt: project.source.archivedAt,
        createdAt: project.source.createdAt,
        updatedAt: project.source.updatedAt,
      });
      insertedProjects += 1;

      for (const workspace of project.workspaces) {
        if (existingImportedWorkspaceIds.has(workspace.id)) continue;
        await tx.insert(projectWorkspaces).values({
          id: workspace.id,
          orgId,
          projectId: project.source.id,
          name: workspace.name,
          sourceType: workspace.sourceType,
          cwd: workspace.cwd,
          repoUrl: workspace.repoUrl,
          repoRef: workspace.repoRef,
          defaultRef: workspace.defaultRef,
          visibility: workspace.visibility,
          setupCommand: workspace.setupCommand,
          cleanupCommand: workspace.cleanupCommand,
          remoteProvider: workspace.remoteProvider,
          remoteWorkspaceRef: workspace.remoteWorkspaceRef,
          sharedWorkspaceKey: workspace.sharedWorkspaceKey,
          metadata: workspace.metadata,
          isPrimary: workspace.isPrimary,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        });
        insertedProjectWorkspaces += 1;
      }
    }

    const issueCandidates = input.plan.issuePlans.filter(
      (plan): plan is PlannedIssueInsert => plan.action === "insert",
    );
    const issueCandidateIds = issueCandidates.map((issue) => issue.source.id);
    const existingIssueIds = issueCandidateIds.length > 0
      ? new Set(
        (await tx
          .select({ id: issues.id })
          .from(issues)
          .where(inArray(issues.id, issueCandidateIds)))
          .map((row) => row.id),
      )
      : new Set<string>();
    const issueInserts = issueCandidates.filter((issue) => !existingIssueIds.has(issue.source.id));

    let nextIssueNumber = 0;
    if (issueInserts.length > 0) {
      const [companyRow] = await tx
        .update(organizations)
        .set({ issueCounter: sql`${organizations.issueCounter} + ${issueInserts.length}` })
        .where(eq(organizations.id, orgId))
        .returning({ issueCounter: organizations.issueCounter });
      nextIssueNumber = companyRow.issueCounter - issueInserts.length + 1;
    }

    const insertedIssueIdentifiers = new Map<string, string>();
    let insertedIssues = 0;
    for (const issue of issueInserts) {
      const issueNumber = nextIssueNumber;
      nextIssueNumber += 1;
      const identifier = `${input.company.issuePrefix}-${issueNumber}`;
      insertedIssueIdentifiers.set(issue.source.id, identifier);
      await tx.insert(issues).values({
        id: issue.source.id,
        orgId,
        projectId: issue.targetProjectId,
        projectWorkspaceId: issue.targetProjectWorkspaceId,
        goalId: issue.targetGoalId,
        parentId: issue.source.parentId,
        title: issue.source.title,
        description: issue.source.description,
        status: issue.targetStatus,
        priority: issue.source.priority,
        assigneeAgentId: issue.targetAssigneeAgentId,
        assigneeUserId: issue.source.assigneeUserId,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        createdByAgentId: issue.targetCreatedByAgentId,
        createdByUserId: issue.source.createdByUserId,
        issueNumber,
        identifier,
        requestDepth: issue.source.requestDepth,
        billingCode: issue.source.billingCode,
        assigneeAgentRuntimeOverrides: issue.targetAssigneeAgentId ? issue.source.assigneeAgentRuntimeOverrides : null,
        executionWorkspaceId: null,
        executionWorkspacePreference: null,
        executionWorkspaceSettings: null,
        startedAt: issue.source.startedAt,
        completedAt: issue.source.completedAt,
        cancelledAt: issue.source.cancelledAt,
        hiddenAt: issue.source.hiddenAt,
        createdAt: issue.source.createdAt,
        updatedAt: issue.source.updatedAt,
      });
      insertedIssues += 1;
    }

    const commentCandidates = input.plan.commentPlans.filter(
      (plan): plan is PlannedCommentInsert => plan.action === "insert",
    );
    const commentCandidateIds = commentCandidates.map((comment) => comment.source.id);
    const existingCommentIds = commentCandidateIds.length > 0
      ? new Set(
        (await tx
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(inArray(issueComments.id, commentCandidateIds)))
          .map((row) => row.id),
      )
      : new Set<string>();

    let insertedComments = 0;
    for (const comment of commentCandidates) {
      if (existingCommentIds.has(comment.source.id)) continue;
      const parentExists = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, comment.source.issueId), eq(issues.orgId, orgId)))
        .then((rows) => rows[0] ?? null);
      if (!parentExists) continue;
      await tx.insert(issueComments).values({
        id: comment.source.id,
        orgId,
        issueId: comment.source.issueId,
        authorAgentId: comment.targetAuthorAgentId,
        authorUserId: comment.source.authorUserId,
        body: comment.source.body,
        createdAt: comment.source.createdAt,
        updatedAt: comment.source.updatedAt,
      });
      insertedComments += 1;
    }

    const documentCandidates = input.plan.documentPlans.filter(
      (plan): plan is PlannedIssueDocumentInsert | PlannedIssueDocumentMerge =>
        plan.action === "insert" || plan.action === "merge_existing",
    );
    let insertedDocuments = 0;
    let mergedDocuments = 0;
    let insertedDocumentRevisions = 0;
    for (const documentPlan of documentCandidates) {
      const parentExists = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, documentPlan.source.issueId), eq(issues.orgId, orgId)))
        .then((rows) => rows[0] ?? null);
      if (!parentExists) continue;

      const conflictingKeyDocument = await tx
        .select({ documentId: issueDocuments.documentId })
        .from(issueDocuments)
        .where(and(eq(issueDocuments.issueId, documentPlan.source.issueId), eq(issueDocuments.key, documentPlan.source.key)))
        .then((rows) => rows[0] ?? null);
      if (
        conflictingKeyDocument
        && conflictingKeyDocument.documentId !== documentPlan.source.documentId
      ) {
        continue;
      }

      const existingDocument = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.id, documentPlan.source.documentId))
        .then((rows) => rows[0] ?? null);

      if (!existingDocument) {
        await tx.insert(documents).values({
          id: documentPlan.source.documentId,
          orgId,
          title: documentPlan.source.title,
          format: documentPlan.source.format,
          latestBody: documentPlan.source.latestBody,
          latestRevisionId: documentPlan.latestRevisionId,
          latestRevisionNumber: documentPlan.latestRevisionNumber,
          createdByAgentId: documentPlan.targetCreatedByAgentId,
          createdByUserId: documentPlan.source.createdByUserId,
          updatedByAgentId: documentPlan.targetUpdatedByAgentId,
          updatedByUserId: documentPlan.source.updatedByUserId,
          createdAt: documentPlan.source.documentCreatedAt,
          updatedAt: documentPlan.source.documentUpdatedAt,
        });
        await tx.insert(issueDocuments).values({
          id: documentPlan.source.id,
          orgId,
          issueId: documentPlan.source.issueId,
          documentId: documentPlan.source.documentId,
          key: documentPlan.source.key,
          createdAt: documentPlan.source.linkCreatedAt,
          updatedAt: documentPlan.source.linkUpdatedAt,
        });
        insertedDocuments += 1;
      } else {
        const existingLink = await tx
          .select({ id: issueDocuments.id })
          .from(issueDocuments)
          .where(eq(issueDocuments.documentId, documentPlan.source.documentId))
          .then((rows) => rows[0] ?? null);
        if (!existingLink) {
          await tx.insert(issueDocuments).values({
            id: documentPlan.source.id,
            orgId,
            issueId: documentPlan.source.issueId,
            documentId: documentPlan.source.documentId,
            key: documentPlan.source.key,
            createdAt: documentPlan.source.linkCreatedAt,
            updatedAt: documentPlan.source.linkUpdatedAt,
          });
        } else {
          await tx
            .update(issueDocuments)
            .set({
              issueId: documentPlan.source.issueId,
              key: documentPlan.source.key,
              updatedAt: documentPlan.source.linkUpdatedAt,
            })
            .where(eq(issueDocuments.documentId, documentPlan.source.documentId));
        }

        await tx
          .update(documents)
          .set({
            title: documentPlan.source.title,
            format: documentPlan.source.format,
            latestBody: documentPlan.source.latestBody,
            latestRevisionId: documentPlan.latestRevisionId,
            latestRevisionNumber: documentPlan.latestRevisionNumber,
            updatedByAgentId: documentPlan.targetUpdatedByAgentId,
            updatedByUserId: documentPlan.source.updatedByUserId,
            updatedAt: documentPlan.source.documentUpdatedAt,
          })
          .where(eq(documents.id, documentPlan.source.documentId));
        mergedDocuments += 1;
      }

      const existingRevisionIds = new Set(
        (
          await tx
            .select({ id: documentRevisions.id })
            .from(documentRevisions)
            .where(eq(documentRevisions.documentId, documentPlan.source.documentId))
        ).map((row) => row.id),
      );
      for (const revisionPlan of documentPlan.revisionsToInsert) {
        if (existingRevisionIds.has(revisionPlan.source.id)) continue;
        await tx.insert(documentRevisions).values({
          id: revisionPlan.source.id,
          orgId,
          documentId: documentPlan.source.documentId,
          revisionNumber: revisionPlan.targetRevisionNumber,
          body: revisionPlan.source.body,
          changeSummary: revisionPlan.source.changeSummary,
          createdByAgentId: revisionPlan.targetCreatedByAgentId,
          createdByUserId: revisionPlan.source.createdByUserId,
          createdAt: revisionPlan.source.createdAt,
        });
        insertedDocumentRevisions += 1;
      }
    }

    const attachmentCandidates = input.plan.attachmentPlans.filter(
      (plan): plan is PlannedAttachmentInsert => plan.action === "insert",
    );
    const existingAttachmentIds = new Set(
      (
        await tx
          .select({ id: issueAttachments.id })
          .from(issueAttachments)
          .where(eq(issueAttachments.orgId, orgId))
      ).map((row) => row.id),
    );
    let insertedAttachments = 0;
    let skippedMissingAttachmentObjects = 0;
    for (const attachment of attachmentCandidates) {
      if (existingAttachmentIds.has(attachment.source.id)) continue;
      const parentExists = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, attachment.source.issueId), eq(issues.orgId, orgId)))
        .then((rows) => rows[0] ?? null);
      if (!parentExists) continue;

      const body = await readSourceAttachmentBody(
        input.sourceStorages,
        orgId,
        attachment.source.objectKey,
      );
      if (!body) {
        skippedMissingAttachmentObjects += 1;
        continue;
      }
      await input.targetStorage.putObject(
        orgId,
        attachment.source.objectKey,
        body,
        attachment.source.contentType,
      );

      await tx.insert(assets).values({
        id: attachment.source.assetId,
        orgId,
        provider: attachment.source.provider,
        objectKey: attachment.source.objectKey,
        contentType: attachment.source.contentType,
        byteSize: attachment.source.byteSize,
        sha256: attachment.source.sha256,
        originalFilename: attachment.source.originalFilename,
        createdByAgentId: attachment.targetCreatedByAgentId,
        createdByUserId: attachment.source.createdByUserId,
        createdAt: attachment.source.assetCreatedAt,
        updatedAt: attachment.source.assetUpdatedAt,
      });

      await tx.insert(issueAttachments).values({
        id: attachment.source.id,
        orgId,
        issueId: attachment.source.issueId,
        assetId: attachment.source.assetId,
        issueCommentId: attachment.targetIssueCommentId,
        createdAt: attachment.source.attachmentCreatedAt,
        updatedAt: attachment.source.attachmentUpdatedAt,
      });
      insertedAttachments += 1;
    }

    return {
      insertedProjects,
      insertedProjectWorkspaces,
      insertedIssues,
      insertedComments,
      insertedDocuments,
      mergedDocuments,
      insertedDocumentRevisions,
      insertedAttachments,
      skippedMissingAttachmentObjects,
      insertedIssueIdentifiers,
    };
  });
}

export async function worktreeMergeHistoryCommand(sourceArg: string | undefined, opts: WorktreeMergeHistoryOptions): Promise<void> {
  if (opts.apply && opts.dry) {
    throw new Error("Use either --apply or --dry, not both.");
  }

  if (sourceArg && opts.from) {
    throw new Error("Use either the positional source argument or --from, not both.");
  }

  const targetEndpoint = opts.to
    ? resolveWorktreeEndpointFromSelector(opts.to, { allowCurrent: true })
    : resolveCurrentEndpoint();
  const sourceEndpoint = opts.from
    ? resolveWorktreeEndpointFromSelector(opts.from, { allowCurrent: true })
    : sourceArg
      ? resolveWorktreeEndpointFromSelector(sourceArg, { allowCurrent: true })
      : await promptForSourceEndpoint(targetEndpoint.rootPath);

  if (path.resolve(sourceEndpoint.configPath) === path.resolve(targetEndpoint.configPath)) {
    throw new Error("Source and target Rudder configs are the same. Choose different --from/--to worktrees.");
  }

  const scopes = parseWorktreeMergeScopes(opts.scope);
  const sourceHandle = await openConfiguredDb(sourceEndpoint.configPath);
  const targetHandle = await openConfiguredDb(targetEndpoint.configPath);
  const sourceStorages = resolveAttachmentLookupStorages({
    sourceEndpoint,
    targetEndpoint,
  });
  const targetStorage = openConfiguredStorage(targetEndpoint.configPath);

  try {
    const company = await resolveMergeCompany({
      sourceDb: sourceHandle.db,
      targetDb: targetHandle.db,
      selector: opts.company,
    });
    let collected = await collectMergePlan({
      sourceDb: sourceHandle.db,
      targetDb: targetHandle.db,
      company,
      scopes,
    });
    if (!opts.yes) {
      const projectSelections = await promptForProjectMappings({
        plan: collected.plan,
        sourceProjects: collected.sourceProjects,
        targetProjects: collected.targetProjects,
      });
      if (
        projectSelections.importProjectIds.length > 0
        || Object.keys(projectSelections.projectIdOverrides).length > 0
      ) {
        collected = await collectMergePlan({
          sourceDb: sourceHandle.db,
          targetDb: targetHandle.db,
          company,
          scopes,
          importProjectIds: projectSelections.importProjectIds,
          projectIdOverrides: projectSelections.projectIdOverrides,
        });
      }
    }

    console.log(renderMergePlan(collected.plan, {
      sourcePath: `${sourceEndpoint.label} (${sourceEndpoint.rootPath})`,
      targetPath: `${targetEndpoint.label} (${targetEndpoint.rootPath})`,
      unsupportedRunCount: collected.unsupportedRunCount,
    }));

    if (!opts.apply) {
      return;
    }

    const confirmed = opts.yes
      ? true
      : await p.confirm({
        message: `Import ${collected.plan.counts.issuesToInsert} issues and ${collected.plan.counts.commentsToInsert} comments from ${sourceEndpoint.label} into ${targetEndpoint.label}?`,
        initialValue: false,
      });
    if (p.isCancel(confirmed) || !confirmed) {
      p.log.warn("Import cancelled.");
      return;
    }

    const applied = await applyMergePlan({
      sourceStorages,
      targetStorage,
      targetDb: targetHandle.db,
      company,
      plan: collected.plan,
    });
    if (applied.skippedMissingAttachmentObjects > 0) {
      p.log.warn(
        `Skipped ${applied.skippedMissingAttachmentObjects} attachments whose source files were missing from storage.`,
      );
    }
    p.outro(
      pc.green(
        `Imported ${applied.insertedProjects} projects (${applied.insertedProjectWorkspaces} workspaces), ${applied.insertedIssues} issues, ${applied.insertedComments} comments, ${applied.insertedDocuments} documents (${applied.insertedDocumentRevisions} revisions, ${applied.mergedDocuments} merged), and ${applied.insertedAttachments} attachments into ${company.issuePrefix}.`,
      ),
    );
  } finally {
    await targetHandle.stop();
    await sourceHandle.stop();
  }
}
