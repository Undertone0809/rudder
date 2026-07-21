import type { ServerAgentRuntimeModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const processAdapter: ServerAgentRuntimeModule = {
  type: "process",
  execute,
  testEnvironment,
  models: [],
  agentConfigurationDoc: `# process agent configuration

Adapter: process

Core fields:
- command (string, required): command to execute
- args (string[] | string, optional): command arguments
- cwd (string, optional): absolute working directory
- env (object, optional): KEY=VALUE environment variables

Chat contract:
- In Chat mode, Rudder writes the complete runtime-neutral Chat prompt, including
  the built-in visualize skill projection, to stdin.
- The process writes its final Rudder result envelope to stdout.
- Inline visual parsing, streaming suppression, stop/failure handling, and
  persistence are owned by Rudder's common Chat pipeline, not this adapter.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`,
};
