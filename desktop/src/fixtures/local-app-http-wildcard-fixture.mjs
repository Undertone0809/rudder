import { writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const port = Number.parseInt(process.env.PORT ?? "0", 10);
const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

server.listen(port, "0.0.0.0", () => {
  writeFileSync(
    path.join(process.cwd(), "wildcard-listener.json"),
    JSON.stringify({ pid: process.pid, port }),
  );
  process.stdout.write(`wildcard fixture listening on 0.0.0.0:${port}\n`);
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
