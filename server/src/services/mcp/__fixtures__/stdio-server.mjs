import readline from "node:readline";

const extraArg = process.argv[2] ?? null;
if (process.env.STUBBORN_MODE === "1") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 60_000);
}
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
  if (message.method === "server/discover") {
    send(message.id, {
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
      resultType: "complete",
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "rudder-stdio-fixture",
          version: "1.0.0",
        },
      },
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
      resultType: "complete",
    });
    return;
  }
  if (message.method !== "tools/call") return;

  if (message.params.name === "sleep") {
    setTimeout(() => send(message.id, {
      content: [{ type: "text", text: "awake" }],
      resultType: "complete",
    }), message.params.arguments?.delayMs ?? 100);
    return;
  }
  if (message.params.name === "large") {
    send(message.id, {
      content: [{
        type: "text",
        text: "x".repeat(message.params.arguments?.bytes ?? 1024),
      }],
      resultType: "complete",
    });
    return;
  }
  send(message.id, {
    content: [{ type: "text", text: "ok" }],
    resultType: "complete",
    structuredContent: {
      pid: process.pid,
      argv0: process.argv0,
      cwd: process.cwd(),
      extraArg,
      staticEnv: process.env.STATIC_ENV ?? null,
      forwardedEnv: process.env.FORWARDED_ENV ?? null,
      secretEnv: process.env.SECRET_ENV ?? null,
      unselectedEnv: process.env.UNSELECTED_SECRET ?? null,
      inheritedHome: process.env.HOME || null,
    },
  });
});
