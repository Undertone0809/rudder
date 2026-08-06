export const type = "hermes_gateway";
export const label = "Hermes API Server";
export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# hermes_gateway agent configuration

Adapter: hermes_gateway

Use when Rudder should invoke a running Hermes API Server over HTTP.

Core fields:
- url (string, required): Hermes API Server base URL (http:// or https://)
- apiKey/authToken/token (string, optional): API_SERVER_KEY bearer token
- model (string, optional): Hermes model or configured model route alias
- timeoutSec (number, optional): total run budget (default 120)
- sessionKeyStrategy (issue|fixed|run, optional): upstream Hermes session mapping
- sessionKey (string, optional): fixed session key when strategy=fixed
- payloadTemplate (object, optional): extra /v1/runs fields

Hermes tool and approval events are projected into Rudder as bounded
synthetic_tool_continuity evidence. They are never labeled native or lossless.
`;
