import type { AgentRuntimeModel } from "@rudderhq/agent-runtime-utils";

export const type = "pi_local";
export const label = "Pi (local)";

export const PI_LOCAL_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export const models: AgentRuntimeModel[] = [
  { id: "kimi-coding/kimi-for-coding", label: "Kimi for Coding" },
  { id: "kimi-coding/kimi-k2-thinking", label: "Kimi K2 Thinking" },
  { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
  { id: "openrouter/deepseek/deepseek-chat", label: "DeepSeek Chat (OpenRouter)" },
];

export const agentConfigurationDoc = `# pi_local agent configuration

Adapter: pi_local

Use when:
- You want Rudder to run Pi (the AI coding agent) locally as the agent runtime
- You want provider/model routing in Pi format (--provider <name> --model <id>)
- You want Pi session resume across heartbeats via --session
- You need Pi's tool set (read, bash, edit, write, grep, find, ls)

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- Pi CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown role/persona instructions file such as SOUL.md; Rudder's shared operating contract is appended separately at runtime
- promptTemplate (string, optional): user prompt template passed as the headless --print message
- model (string, required): Pi model id in provider/model format (for example kimi-coding/kimi-for-coding or deepseek/deepseek-chat)
- modelFallbacks (array, optional): ordered fallback attempts as { agentRuntimeType, model, config? }; each may use a different runtime/provider
- thinking (string, optional): thinking level passed via --thinking. Pi supports off|minimal|low|medium|high|xhigh; model-specific thinkingLevelMap entries can remove unsupported levels or map levels to provider values.
- command (string, optional): defaults to "pi"
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Pi supports multiple providers and models. Rudder shows known starter models even when \`pi --list-models\` cannot discover them yet; use \`pi --list-models\` to inspect the local Pi profile.
- Rudder requires an explicit \`model\` value for \`pi_local\` agents.
- Custom provider/model IDs may be typed directly in Rudder. Use \`provider/model\`,
  for example \`deepseek/deepseek-chat\`. For native DeepSeek, authenticate Pi
  with \`DEEPSEEK_API_KEY\` in the runtime env or \`pi /login\`. Rudder onboarding
  only selects the model; provider authentication remains a Pi runtime concern. If Pi reports
  an OpenRouter credential error for a DeepSeek-looking model ID, set
  \`OPENROUTER_API_KEY\` or add a native DeepSeek provider/model to
  \`~/.pi/agent/models.json\`. Use Rudder's environment test as the source of
  truth.
- Sessions are stored in ~/.pi/paperclips/ and resumed with --session.
- Rudder realizes only the bundled Rudder skills plus the skills explicitly enabled on the agent's Skills page.
- Pi runs keep HOME/USERPROFILE on the operator home for normal local CLI auth and host tooling state; RUDDER_OPERATOR_HOME records the same boundary.
- Selected skills, Pi agent state, session files, and isolated Git config live in adapter-managed runtime state through PI_CODING_AGENT_DIR and PI_CODING_AGENT_SESSION_DIR.
- Operator HOME does not authorize provider-native, project, global, stale, or unselected skills to become Rudder-loaded skills.
- All tools (read, bash, edit, write, grep, find, ls) are enabled by default.
- Agent instructions are appended to Pi's system prompt via --append-system-prompt, while the user task is sent as the --print JSON-mode message.
- Rudder parses Pi's full JSON stdout for final text, usage, and tool events, but stores a sanitized stdout view so large thinking/signature payloads do not dominate run logs.
`;
