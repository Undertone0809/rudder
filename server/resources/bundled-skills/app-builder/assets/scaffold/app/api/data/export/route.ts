import { buildExportEnvelope } from "@/lib/data-transfer";
import { getDatabase } from "@/lib/db/client";
import { contacts } from "@/lib/db/schema";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const payload = buildExportEnvelope(
    await getDatabase().db.select().from(contacts).all(),
  );
  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Disposition": `attachment; filename="rudder-app-export-${Date.now()}.json"`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
