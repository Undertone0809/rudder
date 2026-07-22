import { execFileSync } from "node:child_process";
import http from "node:http";

const port = Number.parseInt(process.env.PORT ?? "0", 10);
const host = process.env.HOST === "127.0.0.1" ? process.env.HOST : "127.0.0.1";
const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
    return;
  }
  if (request.url === "/env") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ path: process.env.PATH }));
    return;
  }
  if (request.url === "/path-probe") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim());
    return;
  }
  if (request.url === "/app" || request.url === "/") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("Rudder harmless Local App fixture");
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});
server.listen(port, host, () => {
  process.stdout.write(`fixture listening on ${host}:${port}\n${"bounded-log ".repeat(100)}\n`);
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
