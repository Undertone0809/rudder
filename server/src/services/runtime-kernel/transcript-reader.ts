import { createCompatibilityTranscriptReader } from "./transcript-reader.compatibility.js";
import type {
  CompatibilityTranscriptReader,
  ReadDatabase,
  TranscriptReader,
  TranscriptReaderFactoryOptions,
  TranscriptReaderOptions,
} from "./transcript-reader.contracts.js";
import { createDatabaseTranscriptReader } from "./transcript-reader.database.js";

export type {
  CompatibilityTranscriptPage, CompatibilityTranscriptReader,
  CompatibilityTranscriptReaderApi, CompatibilityTranscriptReaderHook, CompatibilityTranscriptReadInput,
  CompatibilityTranscriptReadResult, LegacyTranscriptReaderHook, LegacyTranscriptReadInput,
  LegacyTranscriptReadResult, NativeSpanSelector, NativeTranscriptRawItem, NativeTranscriptReaderHook, NativeTranscriptReadInput,
  NativeTranscriptReadResult, ReadConversationTranscript, ReadRunTranscript, ReadTranscriptItem, ReadTranscriptScope, TranscriptAvailability,
  TranscriptCompleteness, TranscriptCursor, TranscriptItem,
  TranscriptPage, TranscriptPrincipal, TranscriptRange, TranscriptRangeBoundary, TranscriptReadAuthorization, TranscriptReader, TranscriptReaderErrorCode, TranscriptReaderFactoryOptions, TranscriptReaderOptions, TranscriptReadLimit, TranscriptReadLimitReason, TranscriptReadScope, TranscriptSource, TranscriptStreamEvent
} from "./transcript-reader.contracts.js";
export { TranscriptReaderError } from "./transcript-reader.normalize.js";
export { decodeTranscriptCursor, encodeTranscriptCursor } from "./transcript-reader.pages.js";
export { createLegacyTranscriptReader } from "./transcript-reader.sources.js";

export function createTranscriptReader(database: ReadDatabase, options?: TranscriptReaderOptions): TranscriptReader;
export function createTranscriptReader(options: TranscriptReaderFactoryOptions): CompatibilityTranscriptReader;
export function createTranscriptReader(
  databaseOrOptions: ReadDatabase | TranscriptReaderFactoryOptions,
  options: TranscriptReaderOptions = {},
): TranscriptReader | CompatibilityTranscriptReader {
  if ("authorize" in databaseOrOptions) return createCompatibilityTranscriptReader(databaseOrOptions);
  return createDatabaseTranscriptReader(databaseOrOptions, options);
}
