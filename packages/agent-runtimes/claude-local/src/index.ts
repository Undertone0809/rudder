export const type = "claude_local";
export const label = "Claude Code (local)";

export const DEFAULT_CLAUDE_LOCAL_MODEL = "deepseek-v4-pro[1m]";

export const models = [
  { id: DEFAULT_CLAUDE_LOCAL_MODEL, label: "DeepSeek V4 Pro (1M)" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", variants: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", variants: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-haiku-4-6", label: "Claude Haiku 4.6", variants: [] },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", variants: [] },
];

export const agentConfigurationDoc = `# claude_local agent configuration

Adapter: claude_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown role/persona instructions file such as SOUL.md; Rudder's shared operating contract is injected separately at runtime
- model (string, optional): Claude Code model id; defaults to ${DEFAULT_CLAUDE_LOCAL_MODEL}
- modelFallbacks (array, optional): ordered fallback attempts as { agentRuntimeType, model, config? }; each may use a different runtime/provider
- effort (string, optional): model-dependent Claude Code effort passed via --effort. The installed Claude Code CLI currently advertises low|medium|high|xhigh|max; Rudder only exposes these levels for model entries with known reasoning metadata and does not infer support for unknown aliases. max is session-only in Claude Code.
- chrome (boolean, optional): pass --chrome when running Claude
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max turns for one run
- permissionMode (string, optional): Claude permission mode passed as --permission-mode when dangerouslySkipPermissions is false; defaults to auto for unattended Rudder issue runs
- dangerouslySkipPermissions (boolean, optional): pass --dangerously-skip-permissions to claude
- command (string, optional): defaults to "claude"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): run workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): workspace runtime service intents; local host-managed services are realized before Claude starts and exposed back via context/env

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- When Rudder realizes a workspace/runtime for a run, it injects RUDDER_WORKSPACE_* and RUDDER_RUNTIME_* env vars for agent-side tooling.
- The default Claude Code model is DeepSeek. Reuse an existing DeepSeek credential by setting DEEPSEEK_API_KEY in the runtime env or organization secret bindings.
- Claude runs keep HOME/USERPROFILE on the operator home for normal local CLI auth and host tooling state; RUDDER_OPERATOR_HOME records the same boundary.
- Rudder keeps Claude adapter-managed runtime state separate through CLAUDE_CONFIG_DIR, sanitized settings, selected skill add-dir paths, runtime temp files, and an isolated Git config pointer.
- Claude loads only the bundled Rudder skills plus the skills explicitly enabled on the agent's Skills page. Operator HOME does not authorize provider-native, project, global, stale, or unselected skills to become Rudder-loaded skills.
`;
