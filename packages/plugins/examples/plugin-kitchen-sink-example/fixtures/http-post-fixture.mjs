import { appendFileSync } from "node:fs";
import http from "node:http";

const port = Number(process.env.RUDDER_PLUGIN_HTTP_FIXTURE_PORT ?? 0);
const logFile = process.env.RUDDER_PLUGIN_HTTP_FIXTURE_LOG;

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("RUDDER_PLUGIN_HTTP_FIXTURE_PORT must be a valid port");
}
if (!logFile) throw new Error("RUDDER_PLUGIN_HTTP_FIXTURE_LOG is required");

const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;

  const request = {
    method: req.method,
    url: req.url,
    headers: {
      "content-type": req.headers["content-type"] ?? null,
      "x-rudder-fixture": req.headers["x-rudder-fixture"] ?? null,
    },
    body: raw,
  };
  appendFileSync(logFile, `${JSON.stringify(request)}\n`, "utf8");

  if (req.method !== "POST" || req.url !== "/plugin-http") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "POST /plugin-http required" }));
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, received: request }));
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  process.stdout.write(`PLUGIN_HTTP_FIXTURE_LISTENING ${actualPort}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
