import { getDatabase } from "@/lib/db/client";
import { contacts } from "@/lib/db/schema";
import { contactUpdateSchema } from "@/lib/domain";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const parsed = contactUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_contact", issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const { id } = await context.params;
  const row = await getDatabase().db.update(contacts)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(contacts.id, id))
    .returning()
    .get();
  if (!row) return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  return NextResponse.json({ contact: row });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const row = await getDatabase().db.delete(contacts).where(eq(contacts.id, id)).returning().get();
  if (!row) return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
