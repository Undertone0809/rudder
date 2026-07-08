import { ensurePathInEnv, resolveCommandPath } from "@rudderhq/agent-runtime-utils/server-utils";
import type { AgentRuntimeAvailability } from "@rudderhq/shared";
import { AGENT_RUNTIME_TYPES } from "@rudderhq/shared";

const LOCAL_RUNTIME_COMMANDS: Record<string, string> = {
  claude_local: "claude",
  codex_local: "codex",
  gemini_local: "gemini",
  opencode_local: "opencode",
  pi_local: "pi",
  cursor: "cursor-agent",
};

const HIDDEN_RUNTIME_TYPES = new Set(["process", "http"]);

function localRuntimeLabel(agentRuntimeType: string) {
  switch (agentRuntimeType) {
    case "claude_local":
      return "Claude Code CLI";
    case "codex_local":
      return "Codex CLI";
    case "gemini_local":
      return "Gemini CLI";
    case "opencode_local":
      return "OpenCode CLI";
    case "pi_local":
      return "Pi CLI";
    case "cursor":
      return "Cursor CLI";
    default:
      return agentRuntimeType;
  }
}

export async function listAgentRuntimeAvailability(
  input: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    now?: Date;
  } = {},
): Promise<AgentRuntimeAvailability[]> {
  const cwd = input.cwd ?? process.cwd();
  const env = ensurePathInEnv(input.env ?? process.env);
  const checkedAt = (input.now ?? new Date()).toISOString();

  const results = await Promise.all(
    AGENT_RUNTIME_TYPES
      .filter((agentRuntimeType) => !HIDDEN_RUNTIME_TYPES.has(agentRuntimeType))
      .map(async (agentRuntimeType): Promise<AgentRuntimeAvailability> => {
        const command = LOCAL_RUNTIME_COMMANDS[agentRuntimeType] ?? null;
        if (!command) {
          return {
            agentRuntimeType,
            status: "unknown",
            command: null,
            resolvedCommand: null,
            message: "This runtime does not use a local CLI command probe.",
            hint: "Configure and test this runtime from its own settings.",
            checkedAt,
          };
        }

        const resolvedCommand = await resolveCommandPath(command, cwd, env);
        if (resolvedCommand) {
          return {
            agentRuntimeType,
            status: "available",
            command,
            resolvedCommand,
            message: `${localRuntimeLabel(agentRuntimeType)} default command is available.`,
            checkedAt,
          };
        }

        return {
          agentRuntimeType,
          status: "unavailable",
          command,
          resolvedCommand: null,
          message: `${localRuntimeLabel(agentRuntimeType)} default command was not found on PATH.`,
          hint: `Install the ${command} CLI, or set a custom command path in Advanced options and run Test runtime chain.`,
          checkedAt,
        };
      }),
  );

  return results;
}
