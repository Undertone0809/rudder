import { getDatabase } from "@/lib/db/client";
import { contacts } from "@/lib/db/schema";
import { contactCreateSchema } from "@/lib/domain";
import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await getDatabase().db.select().from(contacts).orderBy(desc(contacts.updatedAt)).all();
  return NextResponse.json({ contacts: rows });
}

export async function POST(request: Request) {
  const parsed = contactCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_contact", issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const now = new Date();
  const row = await getDatabase().db.insert(contacts).values({
    ...parsed.data,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  }).returning().get();
  return NextResponse.json({ contact: row }, { status: 201 });
}
