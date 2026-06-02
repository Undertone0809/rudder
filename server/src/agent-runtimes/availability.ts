import type { AgentRuntimeAvailability } from "@rudderhq/shared";
import {
  ensureCommandResolvable,
  ensurePathInEnv,
} from "@rudderhq/agent-runtime-utils/server-utils";
import { DEFAULT_CURSOR_LOCAL_COMMAND } from "@rudderhq/agent-runtime-cursor-local";

type LocalRuntimeAvailabilityDefinition = {
  agentRuntimeType: string;
  label: string;
  command: string;
  installUrl: string;
  installLabel: string;
};

export const LOCAL_RUNTIME_AVAILABILITY_DEFINITIONS: LocalRuntimeAvailabilityDefinition[] = [
  {
    agentRuntimeType: "claude_local",
    label: "Claude Code",
    command: "claude",
    installUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
    installLabel: "Install Claude Code",
  },
  {
    agentRuntimeType: "codex_local",
    label: "Codex",
    command: "codex",
    installUrl: "https://developers.openai.com/codex/",
    installLabel: "Install Codex",
  },
  {
    agentRuntimeType: "gemini_local",
    label: "Gemini CLI",
    command: "gemini",
    installUrl: "https://github.com/google-gemini/gemini-cli",
    installLabel: "Install Gemini CLI",
  },
  {
    agentRuntimeType: "opencode_local",
    label: "OpenCode",
    command: "opencode",
    installUrl: "https://opencode.ai/docs/",
    installLabel: "Install OpenCode",
  },
  {
    agentRuntimeType: "pi_local",
    label: "Pi",
    command: "pi",
    installUrl: "https://www.mintlify.com/badlogic/pi-mono/installation",
    installLabel: "Install Pi",
  },
  {
    agentRuntimeType: "cursor",
    label: "Cursor",
    command: DEFAULT_CURSOR_LOCAL_COMMAND,
    installUrl: "https://cursor.com/download",
    installLabel: "Install Cursor",
  },
];

export async function listLocalAgentRuntimeAvailability(input: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<AgentRuntimeAvailability[]> {
  const cwd = input.cwd ?? process.cwd();
  const env = ensurePathInEnv(input.env ?? process.env);
  const checkedAt = new Date().toISOString();

  return Promise.all(
    LOCAL_RUNTIME_AVAILABILITY_DEFINITIONS.map(async (definition) => {
      try {
        await ensureCommandResolvable(definition.command, cwd, env);
        return {
          ...definition,
          status: "available",
          available: true,
          detail: null,
          checkedAt,
        } satisfies AgentRuntimeAvailability;
      } catch (err) {
        return {
          ...definition,
          status: "missing",
          available: false,
          detail: err instanceof Error ? err.message : "Command is not executable",
          checkedAt,
        } satisfies AgentRuntimeAvailability;
      }
    }),
  );
}
