import readline from "node:readline";

const extraArg = process.argv[2] ?? null;
const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "rudder-stdio-fixture", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send(message.id, {
      tools: [
        {
          name: "inspect",
          description: "Inspect process inputs",
          inputSchema: { type: "object" },
        },
        {
          name: "sleep",
          description: "Delay a response",
          inputSchema: {
            type: "object",
            properties: { delayMs: { type: "number" } },
          },
        },
        {
          name: "large",
          description: "Return a bounded-test payload",
          inputSchema: {
            type: "object",
            properties: { bytes: { type: "number" } },
          },
        },
      ],
    });
    return;
  }
  if (message.method !== "tools/call") return;

  if (message.params.name === "sleep") {
    setTimeout(() => send(message.id, {
      content: [{ type: "text", text: "awake" }],
    }), message.params.arguments?.delayMs ?? 100);
    return;
  }
  if (message.params.name === "large") {
    send(message.id, {
      content: [{
        type: "text",
        text: "x".repeat(message.params.arguments?.bytes ?? 1024),
      }],
    });
    return;
  }
  send(message.id, {
    content: [{ type: "text", text: "ok" }],
    structuredContent: {
      pid: process.pid,
      cwd: process.cwd(),
      extraArg,
      selectedEnv: process.env.SELECTED_ENV ?? null,
      unselectedEnv: process.env.UNSELECTED_SECRET ?? null,
    },
  });
});
