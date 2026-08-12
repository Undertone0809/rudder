import http from "node:http";

const port = Number.parseInt(process.env.PORT ?? "0", 10);
const host = process.env.HOST === "127.0.0.1" ? process.env.HOST : "127.0.0.1";
const chunk = Buffer.alloc(10 * 1024, 0x78);
const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
    return;
  }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("Rudder Local App flood fixture");
});
server.listen(port, host, () => {
  process.stdout.write(`fixture listening on ${host}:${port}\n`);
});
const flood = setInterval(() => {
  process.stdout.write(chunk);
}, 1);
const stop = () => {
  clearInterval(flood);
  server.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
