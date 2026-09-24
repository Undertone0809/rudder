import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { getObservedRunLog } from "../../../../server/src/services/run-intelligence.ts";
import { getRunLogStore } from "../../../../server/src/services/run-log-store.ts";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function queryFor(rows) {
  const query = {
    from: () => query,
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return query;
}

const db = {
  select(fields) {
    const keys = Object.keys(fields ?? {});
    if (keys.includes("logStore")) {
      return queryFor([{ id: RUN_ID, logStore: "local_file", logRef: path.join("org-1", "agent-1", `${RUN_ID}.ndjson`) }]);
    }
    if (keys.join(",") === "orgId,chatConversationId,scene,contextSnapshot") {
      return queryFor([{ orgId: "org-1", chatConversationId: null, scene: null, contextSnapshot: null }]);
    }
    if (keys.length === 1 && keys[0] === "id") return queryFor([]);
    if (keys.length === 1 && keys[0] === "orgId") return queryFor([{ orgId: "org-1" }]);
    if (keys.length === 0) {
      return queryFor([{
        id: "settings-1",
        singletonKey: "default",
        browser: {},
        general: { censorUsernameInLogs: false },
        notifications: {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }]);
    }
    throw new Error(`Unexpected fixture select: ${keys.join(",")}`);
  },
};

const store = getRunLogStore();
const handle = await store.begin({ orgId: "org-1", agentId: "agent-1", runId: RUN_ID });
await fs.writeFile(path.join(process.env.RUN_LOG_BASE_PATH, handle.logRef), process.env.EVIDENCE_SOURCE ?? "");

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== `/api/run-intelligence/runs/${RUN_ID}/log`) {
      response.writeHead(404).end();
      return;
    }
    const result = await getObservedRunLog(db, RUN_ID, { orgIds: ["org-1"] }, {
      offset: Number(url.searchParams.get("offset")),
      limitBytes: Number(url.searchParams.get("limitBytes")),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result.response));
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind a TCP port");
  process.stdout.write(`${address.port}\n`);
});

process.once("SIGTERM", () => server.close(() => process.exit(0)));
