import { Command, CommanderError } from "commander";
import { onboard } from "./commands/onboard.js";
import { doctor } from "./commands/doctor.js";
import { envCommand } from "./commands/env.js";
import { configure } from "./commands/configure.js";
import { startCommand } from "./commands/start.js";
import { addAllowedHostname } from "./commands/allowed-hostname.js";
import { heartbeatRun } from "./commands/heartbeat-run.js";
import { runCommand } from "./commands/run.js";
import { bootstrapCeoInvite } from "./commands/auth-bootstrap-ceo.js";
import { dbBackupCommand } from "./commands/db-backup.js";
import { registerContextCommands } from "./commands/client/context.js";
import { registerCompanyCommands } from "./commands/client/company.js";
import { registerIssueCommands } from "./commands/client/issue.js";
import { registerAgentCommands } from "./commands/client/agent.js";
import { registerApprovalCommands } from "./commands/client/approval.js";
import { registerActivityCommands } from "./commands/client/activity.js";
import { registerDashboardCommands } from "./commands/client/dashboard.js";
import { registerSkillCommands } from "./commands/client/skill.js";
import { applyDataDirOverride, type DataDirOptionLike } from "./config/data-dir.js";
import { loadRudderEnvFile } from "./config/env.js";
import { applyLocalEnvProfile } from "./config/local-env.js";
import { registerWorktreeCommands } from "./commands/worktree.js";
import { registerPluginCommands } from "./commands/client/plugin.js";
import { registerClientAuthCommands } from "./commands/client/auth.js";
import { registerCreateAgentBenchmarkCommands } from "./commands/benchmark-create-agent.js";
import { resolveCliVersion } from "./version.js";

const DATA_DIR_OPTION_HELP =
  "Rudder data directory root (isolates state from ~/.rudder)";
const LOCAL_ENV_OPTION_HELP =
  "Local environment profile (dev, prod_local, e2e)";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("rudder")
    .description("Rudder CLI — setup, diagnose, and configure your instance")
    .version(resolveCliVersion());

  program.option("--local-env <name>", LOCAL_ENV_OPTION_HELP);

  program.hook("preAction", (_thisCommand, actionCommand) => {
    const options = actionCommand.optsWithGlobals() as DataDirOptionLike;
    applyLocalEnvProfile(options);
    const optionNames = new Set(actionCommand.options.map((option) => option.attributeName()));
    applyDataDirOverride(options, {
      hasConfigOption: optionNames.has("config"),
      hasContextOption: optionNames.has("context"),
    });
    loadRudderEnvFile(options.config);
  });

  program
    .command("start")
    .description("Start Rudder Desktop and prepare the matching persistent CLI")
    .option("--no-cli", "Skip persistent CLI installation")
    .option("--no-desktop", "Skip desktop app installation")
    .option("--version <version>", "Rudder version to start (default: current CLI version)")
    .option("--repo <owner/repo>", "GitHub repository that hosts desktop releases")
    .option("--output-dir <path>", "Directory for downloaded desktop release assets")
    .option("--desktop-install-dir <path>", "Directory for the portable Desktop install")
    .option("--no-open", "Install Desktop without launching it")
    .option("--no-version-check", "Skip checking npm for a newer Rudder CLI version")
    .option("--dry-run", "Print the start actions without changing the machine", false)
    .action(startCommand);

  program
    .command("onboard")
    .description("Interactive first-run setup wizard")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .option("-y, --yes", "Accept defaults (quickstart + start immediately)", false)
    .option("--run", "Start Rudder immediately after saving config", false)
    .action(onboard);

  program
    .command("doctor")
    .description("Run diagnostic checks on your Rudder setup")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .option("--repair", "Attempt to repair issues automatically")
    .alias("--fix")
    .option("-y, --yes", "Skip repair confirmation prompts")
    .action(async (opts) => {
      await doctor(opts);
    });

  program
    .command("env")
    .description("Print environment variables for deployment")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .action(envCommand);

  program
    .command("configure")
    .description("Update configuration sections")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .option("-s, --section <section>", "Section to configure (llm, database, logging, server, storage, secrets)")
    .action(configure);

  program
    .command("db:backup")
    .description("Create a one-off database backup using current config")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .option("--dir <path>", "Backup output directory (overrides config)")
    .option("--retention-days <days>", "Retention window used for pruning", (value) => Number(value))
    .option("--filename-prefix <prefix>", "Backup filename prefix", "rudder")
    .option("--json", "Print backup metadata as JSON")
    .action(async (opts) => {
      await dbBackupCommand(opts);
    });

  program
    .command("allowed-hostname")
    .description("Allow a hostname for authenticated/private mode access")
    .argument("<host>", "Hostname to allow (for example dotta-macbook-pro)")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .action(addAllowedHostname);

  program
    .command("run")
    .description("Bootstrap local setup (onboard + doctor) and run Rudder")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .option("-i, --instance <id>", "Local instance id (default: default)")
    .option("--repair", "Attempt automatic repairs during doctor", true)
    .option("--no-repair", "Disable automatic repairs during doctor")
    .action(runCommand);

  const heartbeat = program.command("heartbeat").description("Heartbeat utilities");

  heartbeat
    .command("run")
    .description("Run one agent heartbeat and stream live logs")
    .requiredOption("-a, --agent-id <agentId>", "Agent ID to invoke")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .option("--context <path>", "Path to CLI context file")
    .option("--profile <name>", "CLI context profile name")
    .option("--api-base <url>", "Base URL for the Rudder server API")
    .option("--api-key <token>", "Bearer token for agent-authenticated calls")
    .option(
      "--source <source>",
      "Invocation source (timer | assignment | on_demand | automation)",
      "on_demand",
    )
    .option("--trigger <trigger>", "Trigger detail (manual | ping | callback | system)", "manual")
    .option("--timeout-ms <ms>", "Max time to wait before giving up", "0")
    .option("--json", "Output raw JSON where applicable")
    .option("--debug", "Show raw adapter stdout/stderr JSON chunks")
    .action(heartbeatRun);

  registerContextCommands(program);
  registerCompanyCommands(program);
  registerIssueCommands(program);
  registerAgentCommands(program);
  registerApprovalCommands(program);
  registerActivityCommands(program);
  registerDashboardCommands(program);
  registerSkillCommands(program);
  registerWorktreeCommands(program);
  registerPluginCommands(program);
  registerCreateAgentBenchmarkCommands(program);

  const auth = program.command("auth").description("Authentication and bootstrap utilities");

  auth
    .command("bootstrap-ceo")
    .description("Create a one-time bootstrap invite URL for first instance admin")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .option("--force", "Create new invite even if admin already exists", false)
    .option("--expires-hours <hours>", "Invite expiration window in hours", (value) => Number(value))
    .option("--base-url <url>", "Public base URL used to print invite link")
    .action(bootstrapCeoInvite);

  registerClientAuthCommands(auth);

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<number> {
  const program = createProgram();
  program.exitOverride();

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return error.exitCode;
      }
      if (error.code === "commander.executeSubCommandAsync") {
        return error.exitCode;
      }
      if (error.exitCode > 0 && error.message) {
        console.error(error.message);
        return error.exitCode;
      }
      return error.exitCode;
    }

    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
