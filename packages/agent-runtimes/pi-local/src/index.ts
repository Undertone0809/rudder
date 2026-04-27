export const type = "pi_local";
export const label = "Pi (local)";

export const models: Array<{ id: string; label: string }> = [];

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
- instructionsFilePath (string, optional): absolute path to a markdown instructions file appended to system prompt via --append-system-prompt
- promptTemplate (string, optional): user prompt template passed via -p flag
- model (string, required): Pi model id in provider/model format (for example xai/grok-4)
- modelFallbacks (string[], optional): up to two backup provider/model ids tried in order when the primary model invocation fails
- thinking (string, optional): thinking level (off, minimal, low, medium, high, xhigh)
- command (string, optional): defaults to "pi"
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Pi supports multiple providers and models. Use \`pi --list-models\` to list available options.
- Rudder requires an explicit \`model\` value for \`pi_local\` agents.
- Sessions are stored in ~/.pi/paperclips/ and resumed with --session.
- Rudder realizes only the bundled Rudder skills plus the skills explicitly enabled on the agent's Skills page.
- Selected skills are linked into a Rudder-managed Pi home for the run; unselected skills already present in the real user home do not load.
- All tools (read, bash, edit, write, grep, find, ls) are enabled by default.
- Agent instructions are appended to Pi's system prompt via --append-system-prompt, while the user task is sent via -p.
`;
