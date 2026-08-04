import type { AgentRuntimeModel } from "@rudderhq/agent-runtime-utils";

export const type = "cursor";
export const label = "Cursor CLI (local)";
export const DEFAULT_CURSOR_LOCAL_MODEL = "auto";

// Cursor CLI advertises these levels for its current session and accepts them
// in the official model[effort=...] parameter syntax. Keep the fallback
// catalog explicit for known reasoning-capable Cursor model IDs; an
// authenticated `cursor-agent models` result can provide richer metadata.
export const CURSOR_LOCAL_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const CURSOR_FALLBACK_MODEL_IDS = [
  "auto",
  "composer-1.5",
  "composer-1",
  "gpt-5.3-codex",
  "gpt-5.3-codex-fast",
  "gpt-5.3-codex-spark-preview",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.2-codex-fast",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "opus-4.6-thinking",
  "opus-4.6",
  "opus-4.5",
  "opus-4.5-thinking",
  "sonnet-4.6",
  "sonnet-4.6-thinking",
  "sonnet-4.5",
  "sonnet-4.5-thinking",
  "gemini-3.1-pro",
  "gemini-3-pro",
  "gemini-3-flash",
  "grok",
  "kimi-k2.5",
];

const CURSOR_FALLBACK_REASONING_MODEL_IDS = new Set([
  "gpt-5.3-codex",
  "gpt-5.3-codex-fast",
  "gpt-5.3-codex-spark-preview",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.2-codex-fast",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "opus-4.6-thinking",
  "opus-4.5-thinking",
  "sonnet-4.6-thinking",
  "sonnet-4.5-thinking",
]);

export function withCursorModelMetadata(modelList: readonly AgentRuntimeModel[]): AgentRuntimeModel[] {
  const byId = new Map<string, AgentRuntimeModel>();
  for (const model of modelList) {
    const id = model.id.trim();
    if (!id) continue;
    const variants = [...(model.variants ?? [])];
    byId.set(id, {
      id,
      label: model.label.trim() || id,
      ...(variants.length > 0 ? { variants: [...new Set(variants)] } : {}),
      ...(typeof model.capabilities?.reasoning === "boolean"
        ? { capabilities: { reasoning: model.capabilities.reasoning } }
        : variants.length > 0
          ? { capabilities: { reasoning: true } }
          : {}),
    });
  }
  return [...byId.values()];
}

/** Merge a UI effort into Cursor's official model[effort=...] syntax. */
export function applyCursorModelEffort(model: string, effort: string | null | undefined): string {
  const normalizedModel = model.trim();
  if (!normalizedModel) return normalizedModel;
  const bracketIndex = normalizedModel.indexOf("[");
  const baseModel = bracketIndex >= 0 ? normalizedModel.slice(0, bracketIndex) : normalizedModel;
  const rawParameters = bracketIndex >= 0 && normalizedModel.endsWith("]")
    ? normalizedModel.slice(bracketIndex + 1, -1)
    : "";
  const parameters = rawParameters
    .split(",")
    .map((parameter) => parameter.trim())
    .filter((parameter) => parameter && !/^effort\s*=/i.test(parameter));
  const normalizedEffort = effort?.trim().toLowerCase();
  if (normalizedEffort && normalizedEffort !== "auto") {
    parameters.push(`effort=${normalizedEffort}`);
  }
  return parameters.length > 0 ? `${baseModel}[${parameters.join(",")}]` : baseModel;
}

export const models = withCursorModelMetadata(CURSOR_FALLBACK_MODEL_IDS.map((id) => ({
  id,
  label: id,
  ...(CURSOR_FALLBACK_REASONING_MODEL_IDS.has(id)
    ? {
        variants: [...CURSOR_LOCAL_REASONING_EFFORTS],
        capabilities: { reasoning: true },
      }
    : {}),
})));

export const agentConfigurationDoc = `# cursor agent configuration

Adapter: cursor

Use when:
- You want Rudder to run Cursor Agent CLI locally as the agent runtime
- You want Cursor chat session resume across heartbeats via --resume
- You want structured stream output in run logs via --output-format stream-json

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- Cursor Agent CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown role/persona instructions file such as SOUL.md; Rudder's shared operating contract is prepended separately at runtime
- promptTemplate (string, optional): run prompt template
- model (string, optional): Cursor model id (for example auto or gpt-5.3-codex)
- effort (string, optional): model-specific reasoning effort passed through Cursor's official parameterized model syntax, for example gpt-5.3-codex[effort=high]. Values come from Cursor's official CLI levels for known fallback models and from discovered model metadata when available.
- modelFallbacks (array, optional): ordered fallback attempts as { agentRuntimeType, model, config? }; each may use a different runtime/provider
- mode (string, optional): Cursor execution mode passed as --mode (plan|ask). Leave unset for normal autonomous runs.
- command (string, optional): defaults to "cursor-agent"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs are executed with: cursor-agent -p --output-format stream-json ...
- Prompts are piped to Cursor via stdin.
- Sessions are resumed with --resume when stored session cwd matches current cwd.
- Rudder realizes only the bundled Rudder skills plus the skills explicitly enabled on the agent's Skills page.
- Cursor runs keep HOME/USERPROFILE on the operator home for normal local CLI auth and host tooling state; RUDDER_OPERATOR_HOME records the same boundary.
- Cursor CLI currently exposes --plugin-dir but no verified skills-directory allowlist or native discovery-disable flag. Rudder links selected skills into a Rudder-managed Cursor sidecar and injects only those selected SKILL.md files into the prompt.
- Rudder auto-adds --yolo unless one of --trust/--yolo/-f is already present in extraArgs.
`;
