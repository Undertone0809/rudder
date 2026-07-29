import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createIdentityDb(url: string) {
  const client = postgres(url, {
    max: 1,
    prepare: false,
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  };
}

export type IdentityDb = ReturnType<typeof createIdentityDb>["db"];
