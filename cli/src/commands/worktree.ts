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
export * from "./worktree-init.js";
export * from "./worktree-cleanup.js";
export * from "./worktree-merge.js";
export * from "./worktree-register.js";
