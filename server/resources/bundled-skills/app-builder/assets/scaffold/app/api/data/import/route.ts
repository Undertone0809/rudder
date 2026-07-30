import { importEnvelopeSchema } from "@/lib/data-transfer";
import { getDatabase } from "@/lib/db/client";
import { contacts } from "@/lib/db/schema";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const parsed = importEnvelopeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_import", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const { db } = getDatabase();
  const imported = await db.transaction(async (transaction) => {
    for (const contact of parsed.data.data.contacts) {
      await transaction.insert(contacts).values({
        ...contact,
        createdAt: new Date(contact.createdAt),
        updatedAt: new Date(contact.updatedAt),
      }).onConflictDoUpdate({
        target: contacts.id,
        set: {
          name: contact.name,
          email: contact.email,
          company: contact.company,
          status: contact.status,
          updatedAt: new Date(contact.updatedAt),
        },
      }).run();
    }
    return parsed.data.data.contacts.length;
  });

  return NextResponse.json({ imported });
}
