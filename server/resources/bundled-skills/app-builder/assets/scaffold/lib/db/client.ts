import {
  drizzle,
  type SqliteRemoteDatabase,
} from "drizzle-orm/sqlite-proxy";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import * as schema from "./schema";

type DatabaseHandle = {
  sqlite: DatabaseSync;
  db: SqliteRemoteDatabase<typeof schema>;
  filePath: string;
};

const handles = new Map<string, DatabaseHandle>();

export function dataMode() {
  return process.env.RUDDER_APP_DATA_MODE === "production"
    ? "production"
    : "development";
}

export function dataDirectory() {
  return process.env.RUDDER_APP_DATA_DIR
    ? path.resolve(process.env.RUDDER_APP_DATA_DIR)
    : path.resolve("data");
}

export function databasePath() {
  if (process.env.RUDDER_APP_DATA_DIR) {
    return path.join(
      dataDirectory(),
      dataMode() === "production" ? "app.sqlite" : "dev.sqlite",
    );
  }
  return path.join(
    dataDirectory(),
    dataMode() === "production" ? "production/app.sqlite" : "development/dev.sqlite",
  );
}

export function getDatabase(): DatabaseHandle {
  const filePath = databasePath();
  const cached = handles.get(filePath);
  if (cached) return cached;

  mkdirSync(path.dirname(filePath), { recursive: true });
  const sqlite = new DatabaseSync(filePath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  const db = drizzle(async (query, parameters, method): Promise<{ rows: unknown[] }> => {
    const statement = sqlite.prepare(query);
    statement.setReturnArrays(true);
    const values = parameters as SQLInputValue[];
    if (method === "run") {
      statement.run(...values);
      return { rows: [] };
    }
    if (method === "get") {
      return { rows: statement.get(...values) as unknown as unknown[] };
    }
    return { rows: statement.all(...values) as unknown as unknown[][] };
  }, { schema });
  const handle: DatabaseHandle = {
    sqlite,
    db,
    filePath,
  };
  handles.set(filePath, handle);
  return handle;
}

export function closeDatabases() {
  for (const handle of handles.values()) handle.sqlite.close();
  handles.clear();
}
