import { getDatabase } from "@/lib/db/client";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    getDatabase().sqlite.prepare("select 1").get();
    return NextResponse.json({
      ok: true,
      schemaVersion: 1,
      dataMode: process.env.RUDDER_APP_DATA_MODE === "production"
        ? "production"
        : "development",
    });
  } catch {
    return NextResponse.json({ ok: false, error: "database_unavailable" }, { status: 503 });
  }
}
