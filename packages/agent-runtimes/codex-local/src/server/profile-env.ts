import { RUDDER_MCP_MANAGED_ENV_KEYS } from "@rudderhq/agent-runtime-utils";
import { resolveTrustedOperatorHome } from "./codex-home.js";

const PROTECTED_ENV_KEYS = new Set([
  "AGENT_HOME", "CODEX_HOME", "HOME", "USERPROFILE",
  ...RUDDER_MCP_MANAGED_ENV_KEYS,
  "RUDDER_DESKTOP_CLI_ENTRY", "RUDDER_COMPUTER_ENABLED", "RUDDER_AGENT_ROOT", "RUDDER_OPERATOR_HOME",
]);

/** Share execute's configuration boundary with native probes and readers. */
export function codexConfiguredEnvironment(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && !PROTECTED_ENV_KEYS.has(entry[0]),
  ));
}

export function buildCodexProfileEnvironment(input: {
  configured: Record<string, unknown>;
  codexHome?: string | null;
}): Record<string, string> {
  const operatorHome = resolveTrustedOperatorHome();
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    ...codexConfiguredEnvironment(input.configured),
    HOME: operatorHome,
    USERPROFILE: process.env.USERPROFILE ?? operatorHome,
    RUDDER_OPERATOR_HOME: operatorHome,
    ...(input.codexHome ? { CODEX_HOME: input.codexHome } : {}),
  };
}
