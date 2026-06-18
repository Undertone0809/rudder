export const type = "codex_local";
export const label = "Codex (local)";
export const DEFAULT_CODEX_LOCAL_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX = true;
export const DEFAULT_CODEX_LOCAL_SEARCH = true;
export const DEFAULT_CODEX_LOCAL_COUNT_SUBSCRIPTION_USAGE_AS_COST = true;

export const models = [
  { id: DEFAULT_CODEX_LOCAL_MODEL, label: "GPT-5.5" },
  { id: "gpt-5.5-codex", label: "GPT-5.5-Codex" },
  { id: "gpt-5.5-fast", label: "GPT-5.5-Fast" },
  { id: "gpt-5.5-flex", label: "GPT-5.5-Flex" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-codex", label: "GPT-5.4-Codex" },
  { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
  { id: "gpt-5.4-nano", label: "GPT-5.4-Nano" },
  { id: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
  { id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
  { id: "gpt-5.2-codex", label: "GPT-5.2-Codex" },
  { id: "gpt-5.1-codex", label: "GPT-5.1-Codex" },
  { id: "gpt-5.1-codex-max", label: "GPT-5.1-Codex-Max" },
  { id: "gpt-5.1-codex-mini", label: "GPT-5.1-Codex-Mini" },
  { id: "gpt-5-codex", label: "GPT-5-Codex" },
  { id: "codex-mini-latest", label: "Codex Mini Latest" },
];

export const agentConfigurationDoc = `# codex_local agent configuration

Adapter: codex_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown role/persona instructions file such as SOUL.md; Rudder's shared operating contract is prepended separately at runtime
- model (string, optional): Codex model id
- modelFallbacks (array, optional): ordered fallback attempts as { agentRuntimeType, model, config? }; each may use a different runtime/provider
- modelReasoningEffort (string, optional): reasoning effort override (low|medium|high|xhigh) passed via -c model_reasoning_effort=...
- promptTemplate (string, optional): run prompt template
- search (boolean, optional, defaults to true on new Codex agents): run codex with --search
- countSubscriptionUsageAsCost (boolean, optional, defaults to true): when Codex uses local subscription auth, estimate API-equivalent spend from token usage instead of recording subscription runs as $0. Known-model estimates count toward Rudder spend and budget hard stops. Rates are stored per model from the OpenAI/Codex price table used by Vibe Usage; unknown models remain subscription usage until added.
- dangerouslyBypassApprovalsAndSandbox (boolean, optional): run with bypass flag
- command (string, optional): defaults to "codex"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): run workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): workspace runtime service intents; local host-managed services are realized before Codex starts and exposed back via context/env

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Prompts are piped via stdin (Codex receives "-" prompt argument).
- Rudder always prepends its shared operating contract to the stdin prompt. If instructionsFilePath is configured, Rudder also prepends that file plus sibling SOUL.md, TOOLS.md, and MEMORY.md when present.
- Codex exec automatically applies repo-scoped AGENTS.md instructions from the active workspace. Rudder cannot suppress that discovery in exec mode, so repo AGENTS.md files may still apply even when you only configured an explicit instructionsFilePath.
- Agent enabled-skill state is controlled only by Rudder's bundled skills plus the selections saved on the agent's Skills page.
- The codex_local adapter does not materialize skills into repo-scoped ".agents/skills"; it realizes selected skills by linking them into the Rudder-managed \`CODEX_HOME/skills\` directory that Codex discovers at runtime.
- Rudder runs Codex with the operator HOME preserved for normal local CLI auth/config, while exporting a per-agent managed CODEX_HOME under the active Rudder instance for Codex runtime state and enabled Rudder skills.
- Adapter env values for HOME, USERPROFILE, RUDDER_OPERATOR_HOME, AGENT_HOME, RUDDER_AGENT_ROOT, and CODEX_HOME do not override those protected runtime paths in the default Codex execution path.
- Rudder sanitizes managed CODEX_HOME/config.toml, disables Codex bundled skills/plugins, strips inherited skill registries, and writes disabled external skill-path entries for operator-home, shared-Codex-home, and repo-local skill roots so runtime loading stays controlled by Rudder's enabled skill set.
- Rudder prepares a managed Git config sidecar for the run, forces user.useConfigOnly=true, and points Git at it with GIT_CONFIG_GLOBAL so commits use the normal repo-local or host Git identity and never fall back to hostname .local authors.
- When Rudder realizes a workspace/runtime for a run, it injects RUDDER_WORKSPACE_* and RUDDER_RUNTIME_* env vars for agent-side tooling.
`;
