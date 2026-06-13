import type { Command } from "commander";
import { worktreeCleanupCommand, worktreeEnvCommand } from "./worktree-cleanup.js";
import { worktreeInitCommand, worktreeMakeCommand } from "./worktree-init.js";
import {
  DEFAULT_WORKTREE_HOME
} from "./worktree-lib.js";
import { worktreeListCommand, worktreeMergeHistoryCommand } from "./worktree-merge.js";

export function registerWorktreeCommands(program: Command): void {
  const worktree = program.command("worktree").description("Worktree-local Rudder instance helpers");

  program
    .command("worktree:make")
    .description("Create ~/NAME as a git worktree, then initialize an isolated Rudder instance inside it")
    .argument("<name>", "Worktree name — auto-prefixed with rudder- if needed (created at ~/rudder-NAME)")
    .option("--start-point <ref>", "Remote ref to base the new branch on (env: RUDDER_WORKTREE_START_POINT)")
    .option("--instance <id>", "Explicit isolated instance id")
    .option("--home <path>", `Home root for worktree instances (env: RUDDER_WORKTREES_DIR, default: ${DEFAULT_WORKTREE_HOME})`)
    .option("--from-config <path>", "Source config.json to seed from")
    .option("--from-data-dir <path>", "Source RUDDER_HOME used when deriving the source config")
    .option("--from-instance <id>", "Source instance id when deriving the source config", "default")
    .option("--server-port <port>", "Preferred server port", (value) => Number(value))
    .option("--db-port <port>", "Preferred embedded Postgres port", (value) => Number(value))
    .option("--seed-mode <mode>", "Seed profile: minimal or full (default: minimal)", "minimal")
    .option("--no-seed", "Skip database seeding from the source instance")
    .option("--force", "Replace existing repo-local config and isolated instance data", false)
    .action(worktreeMakeCommand);

  worktree
    .command("init")
    .description("Create repo-local config/env and an isolated instance for this worktree")
    .option("--name <name>", "Display name used to derive the instance id")
    .option("--instance <id>", "Explicit isolated instance id")
    .option("--home <path>", `Home root for worktree instances (env: RUDDER_WORKTREES_DIR, default: ${DEFAULT_WORKTREE_HOME})`)
    .option("--from-config <path>", "Source config.json to seed from")
    .option("--from-data-dir <path>", "Source RUDDER_HOME used when deriving the source config")
    .option("--from-instance <id>", "Source instance id when deriving the source config", "default")
    .option("--server-port <port>", "Preferred server port", (value) => Number(value))
    .option("--db-port <port>", "Preferred embedded Postgres port", (value) => Number(value))
    .option("--seed-mode <mode>", "Seed profile: minimal or full (default: minimal)", "minimal")
    .option("--no-seed", "Skip database seeding from the source instance")
    .option("--force", "Replace existing repo-local config and isolated instance data", false)
    .action(worktreeInitCommand);

  worktree
    .command("env")
    .description("Print shell exports for the current worktree-local Rudder instance")
    .option("-c, --config <path>", "Path to config file")
    .option("--json", "Print JSON instead of shell exports")
    .action(worktreeEnvCommand);

  program
    .command("worktree:list")
    .description("List git worktrees visible from this repo and whether they look like Rudder worktrees")
    .option("--json", "Print JSON instead of text output")
    .action(worktreeListCommand);

  program
    .command("worktree:merge-history")
    .description("Preview or import issue/comment history from another worktree into the current instance")
    .argument("[source]", "Optional source worktree path, directory name, or branch name (back-compat alias for --from)")
    .option("--from <worktree>", "Source worktree path, directory name, branch name, or current")
    .option("--to <worktree>", "Target worktree path, directory name, branch name, or current (defaults to current)")
    .option("--company <id-or-prefix>", "Shared company id or issue prefix inside the chosen source/target instances")
    .option("--scope <items>", "Comma-separated scopes to import (issues, comments)", "issues,comments")
    .option("--apply", "Apply the import after previewing the plan", false)
    .option("--dry", "Preview only and do not import anything", false)
    .option("--yes", "Skip the interactive confirmation prompt when applying", false)
    .action(worktreeMergeHistoryCommand);

  program
    .command("worktree:cleanup")
    .description("Safely remove a worktree, its branch, and its isolated instance data")
    .argument("<name>", "Worktree name — auto-prefixed with rudder- if needed")
    .option("--instance <id>", "Explicit instance id (if different from the worktree name)")
    .option("--home <path>", `Home root for worktree instances (env: RUDDER_WORKTREES_DIR, default: ${DEFAULT_WORKTREE_HOME})`)
    .option("--force", "Bypass safety checks (uncommitted changes, unique commits)", false)
    .action(worktreeCleanupCommand);
}

