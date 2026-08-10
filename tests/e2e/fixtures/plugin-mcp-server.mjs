import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { resources: {}, tools: {} },
      serverInfo: { name: "rudder-plugin-e2e", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send(message.id, {
      tools: [{
        name: "research_status",
        description: "Return the current research status.",
        inputSchema: { type: "object", additionalProperties: false },
      }],
    });
    return;
  }
  if (message.method === "resources/list") {
    send(message.id, {
      resources: [{
        uri: "ui://research/status",
        name: "Research status",
        description: "A compact Plugin MCP status surface.",
        mimeType: "text/html;profile=mcp-app",
      }],
    });
    return;
  }
  if (message.method === "resources/read") {
    send(message.id, {
      contents: [{
        uri: message.params.uri,
        mimeType: "text/html",
        text: "<!doctype html><html><body><main><h1>Research UI</h1><p>Connected through the Plugin MCP.</p></main></body></html>",
      }],
    });
    return;
  }
  if (message.method === "tools/call") {
    send(message.id, { content: [{ type: "text", text: "ready" }] });
  }
});
