import { backup, DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { databasePath } from "@/lib/db/client";

const source = databasePath();
const snapshotDir = path.resolve("data", "snapshots");
await mkdir(snapshotDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(":", "-");
const destination = path.join(snapshotDir, `${path.basename(source, ".sqlite")}-${stamp}.sqlite`);
const sqlite = new DatabaseSync(source, { readOnly: true });
try {
  await backup(sqlite, destination);
} finally {
  sqlite.close();
}
process.stdout.write(`${destination}\n`);
