import { conflict } from "../errors.js";
import { TranscriptReaderError } from "./runtime-kernel/transcript-reader.js";

/** Retry an entire projection, never combine pages from different revisions. */
export async function readManifestTranscriptSnapshot<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof TranscriptReaderError) || error.code !== "cursor_revision_mismatch") throw error;
      if (attempt === 2) {
        throw conflict("Chat activity changed while reading its work manifest. Please retry.", {
          code: "work_manifest_revision_changed",
        });
      }
    }
  }
  throw new Error("Manifest snapshot retry exhausted");
}
