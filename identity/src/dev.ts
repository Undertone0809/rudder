import { createServer } from "node:http";
import { identityHandler } from "./handler.js";

const baseUrl = new URL(process.env.IDENTITY_BASE_URL ?? "http://127.0.0.1:3200");
const port = Number(baseUrl.port || (baseUrl.protocol === "https:" ? 443 : 80));

createServer((req, res) => {
  void identityHandler(req, res).catch((error: unknown) => {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "internal_server_error" }));
    console.error(error instanceof Error ? error.message : "Identity request failed");
  });
}).listen(port, baseUrl.hostname, () => {
  console.log(`Rudder Identity listening on ${baseUrl.origin}`);
});
