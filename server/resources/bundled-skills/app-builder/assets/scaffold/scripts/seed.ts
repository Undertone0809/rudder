import { closeDatabases, dataMode, getDatabase } from "@/lib/db/client";
import { contacts } from "@/lib/db/schema";
import { sql } from "drizzle-orm";

const { db } = getDatabase();
const existing = (await db.select({ count: sql<number>`count(*)` }).from(contacts).get())?.count ?? 0;
if (dataMode() === "development" && existing === 0) {
  const now = new Date();
  await db.insert(contacts).values([
    {
      id: "a1e99a5d-8fe0-43b9-90dc-5f67718d31dd",
      name: "Maya Chen",
      email: "maya@example.test",
      company: "Northwind",
      status: "replied",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "ac046a8a-80d7-4650-a235-3244dbf90b76",
      name: "Jon Bell",
      email: "jon@example.test",
      company: "Contoso",
      status: "contacted",
      createdAt: now,
      updatedAt: now,
    },
  ]).run();
}
closeDatabases();
process.stdout.write(`Development seed is ready (${existing === 0 ? "created" : "preserved"})\n`);
