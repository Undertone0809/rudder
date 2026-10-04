import { transcriptReaderError } from "./transcript-reader.normalize.js";

export type LegacyReadPhase = "log" | "result" | "context" | "events" | "raw";

export interface LegacyReadCursor {
  version: 1;
  phase: LegacyReadPhase;
  offset: number;
  skipEntries: number;
  totalBytes: number;
  totalItems: number;
  /** True after the original legacy log object returned 404 and a retained source was selected. */
  missingLog?: boolean;
  /** Number of normalized transcript entries already emitted by retained-source pages. */
  totalEntries?: number;
  eventCursor?: string | null;
}

export function encodeLegacyCursor(cursor: LegacyReadCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeLegacyCursor(value: string | null | undefined): LegacyReadCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<LegacyReadCursor>;
    if (parsed.version !== 1
      || !["log", "result", "context", "events", "raw"].includes(parsed.phase ?? "")
      || !Number.isSafeInteger(parsed.offset) || parsed.offset! < 0
      || !Number.isSafeInteger(parsed.skipEntries) || parsed.skipEntries! < 0
      || !Number.isSafeInteger(parsed.totalBytes) || parsed.totalBytes! < 0
      || !Number.isSafeInteger(parsed.totalItems) || parsed.totalItems! < 0
      || (parsed.missingLog !== undefined && typeof parsed.missingLog !== "boolean")
      || (parsed.totalEntries !== undefined && (!Number.isSafeInteger(parsed.totalEntries) || parsed.totalEntries < 0))
      || (parsed.eventCursor !== undefined && parsed.eventCursor !== null && typeof parsed.eventCursor !== "string")) {
      throw new Error("invalid legacy cursor");
    }
    return parsed as LegacyReadCursor;
  } catch {
    throw transcriptReaderError("cursor_invalid", "Invalid legacy transcript cursor");
  }
}
