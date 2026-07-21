import type { ServerAgentRuntimeModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const httpAdapter: ServerAgentRuntimeModule = {
  type: "http",
  execute,
  testEnvironment,
  models: [],
  agentConfigurationDoc: `# http agent configuration

Adapter: http

Core fields:
- url (string, required): endpoint to invoke
- method (string, optional): HTTP method, default POST
- headers (object, optional): request headers
- payloadTemplate (object, optional): JSON payload template
- timeoutSec (number, optional): request timeout in seconds

Chat contract:
- The request body includes context.chatMode=true, the complete context.chatPrompt
  with the built-in visualize skill projection, and
  context.rudderChatInlineVisualProtocolVersion=1.
- Return plain text or a JSON object with text, message, content, or summary.
- Rudder bounds the decoded response body to 4 MiB before JSON parsing; the
  common inline-visual parser then enforces its tighter 256 KiB reply limit.
- Inline visual parsing, streaming suppression, stop/failure handling, and
  persistence are owned by Rudder's common Chat pipeline, not this adapter.
`,
};
