// Disposable process fixture: faults wrap the real publisher, never its SQL.
import { createDb, type Db } from "../../packages/db/src/index.js";
import { subscribeCompanyLiveEvents } from "../../server/src/services/live-events.js";
import { startOrganizationMutationOutboxPublisher } from "../../server/src/services/organization-mutation-outbox.js";

const url = process.env.RUDDER_OUTBOX_TEST_DATABASE_URL;
const orgId = process.env.RUDDER_OUTBOX_TEST_ORG_ID;
if (!url || !orgId || !process.send) throw new Error("Disposable IPC fixture requires database and organization");
const mode = process.argv[2];
const db = createDb(url);
let claimed = false;
const client = new Proxy(db, {
  get(target, key, receiver) {
    if (key !== "execute" || mode !== "hold-claim") return Reflect.get(target, key, receiver);
    return async (...args: Parameters<Db["execute"]>) => {
      const result = await target.execute(...args);
      if (!claimed && Array.isArray(result) && result.length > 0) {
        claimed = true;
        process.send!({ kind: "claimed" });
        await new Promise<void>((resolve) => process.once("message", () => resolve()));
      }
      return result;
    };
  },
});
subscribeCompanyLiveEvents(orgId, (event) => {
  process.send!({ kind: "published", dedupeKey: event.dedupeKey });
  if (mode === "crash-before-ack") {
    // Parent SIGKILLs this process while the real transaction holds the row.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  if (mode === "fail-publication") throw new Error("disposable publication fault");
});
const publisher = startOrganizationMutationOutboxPublisher(client, {
  intervalMs: 100,
  leaseMs: 500,
  workerId: `disposable-outbox:${process.pid}`,
});
await publisher.drain();
process.send({ kind: "drained" });
