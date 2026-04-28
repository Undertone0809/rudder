export const type = "opencode_local";
export const label = "OpenCode (local)";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# opencode_local agent configuration

Adapter: opencode_local

Use when:
- You want Rudder to run OpenCode locally as the agent runtime
- You want provider/model routing in OpenCode format (provider/model)
- You want OpenCode session resume across heartbeats via --session

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- OpenCode CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, required): OpenCode model id in provider/model format (for example anthropic/claude-sonnet-4-5)
- modelFallbacks (array, optional): ordered fallback attempts as { agentRuntimeType, model, config? }; each may use a different runtime/provider
- variant (string, optional): provider-specific model variant (for example minimal|low|medium|high|max)
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "opencode"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- OpenCode supports multiple providers and models. Use \
  \`opencode models\` to list available options in provider/model format.
- Rudder requires an explicit \`model\` value for \`opencode_local\` agents.
- Rudder loads only the bundled Rudder skills plus the skills explicitly enabled on the agent's Skills page; user-home Claude/OpenCode skills are discovery candidates until selected there.
- Runs are executed with: opencode run --format json ...
- Sessions are resumed with --session when stored session cwd matches current cwd.
`;
