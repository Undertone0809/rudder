import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { CoverageIdentity } from "./native-transcript-coverage.js";

export const CODEX_GAP_ENCODING = "codex-gap-dictionary-v1";
const DICTIONARY_BYTES = 32 * 1024;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

type CompactObjectBinding = Pick<CoverageIdentity, "orgId" | "runId" | "spanId" | "ownerToken">;

export type CodexGapObjectMetadata = {
  encoding: typeof CODEX_GAP_ENCODING;
  compactIdentitySha256: string;
  logicalBytes: number;
};

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Compact only a new object with a complete identity bound to its owner. */
export function createCodexGapObjectMetadata(identity: unknown, binding: CompactObjectBinding): CodexGapObjectMetadata | undefined {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return undefined;
  if (!nonEmptyString(binding.orgId) || !nonEmptyString(binding.runId)
    || !nonEmptyString(binding.spanId) || !nonEmptyString(binding.ownerToken)) return undefined;
  const candidate = identity as Record<string, unknown>;
  const selector = candidate.selector;
  if (candidate.orgId !== binding.orgId || candidate.runId !== binding.runId
    || candidate.spanId !== binding.spanId || candidate.ownerToken !== binding.ownerToken
    || !nonEmptyString(candidate.attemptId)
    || typeof candidate.attemptEpoch !== "number" || !Number.isSafeInteger(candidate.attemptEpoch) || candidate.attemptEpoch < 1
    || !selector || typeof selector !== "object" || Array.isArray(selector)) return undefined;
  const selectorIdentity = selector as Record<string, unknown>;
  if (selectorIdentity.kind !== "codex_turn" || selectorIdentity.runId !== binding.runId
    || !nonEmptyString(selectorIdentity.threadId) || !nonEmptyString(selectorIdentity.turnId)) return undefined;

  const boundIdentity: CoverageIdentity = {
    orgId: binding.orgId,
    runId: binding.runId,
    spanId: binding.spanId,
    attemptId: candidate.attemptId,
    attemptEpoch: candidate.attemptEpoch,
    ownerToken: binding.ownerToken,
    selector: {
      kind: "codex_turn",
      runId: binding.runId,
      threadId: selectorIdentity.threadId,
      turnId: selectorIdentity.turnId,
    },
  };
  return {
    encoding: CODEX_GAP_ENCODING,
    compactIdentitySha256: digest(Buffer.from(JSON.stringify(boundIdentity), "utf8")),
    logicalBytes: 0,
  };
}

export function isCodexGapObjectMetadata(value: unknown): value is CodexGapObjectMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  return metadata.encoding === CODEX_GAP_ENCODING
    && typeof metadata.compactIdentitySha256 === "string"
    && /^[a-f0-9]{64}$/u.test(metadata.compactIdentitySha256)
    && Number.isSafeInteger(metadata.logicalBytes) && Number(metadata.logicalBytes) >= 0;
}

/** A self-contained backward byte reference, NOT a native retention proof.
 * Every previous committed line supplies the recovery dictionary. No separate
 * full payload or shadow is written. Unknown/unprofitable lines stay literal.
 * Digest/length checks preserve the exact JSON bytes, including timing and order.
 */
export class CodexGapDictionary {
  private dictionary: Buffer;

  constructor(dictionary: Buffer = Buffer.alloc(0)) {
    this.dictionary = Buffer.from(dictionary.subarray(-DICTIONARY_BYTES));
  }

  snapshot(): Buffer { return Buffer.from(this.dictionary); }

  private advance(bytes: Buffer) {
    this.dictionary = bytes.length >= DICTIONARY_BYTES
      ? Buffer.from(bytes.subarray(-DICTIONARY_BYTES))
      : Buffer.concat([this.dictionary, bytes]).subarray(-DICTIONARY_BYTES);
  }

  encode(line: string): string {
    const bytes = Buffer.from(line, "utf8");
    const compressed = deflateRawSync(bytes, { dictionary: this.dictionary });
    const encoded = JSON.stringify({ version: 2, encoding: CODEX_GAP_ENCODING,
      bytes: bytes.length, sha256: digest(bytes), dictionarySha256: digest(this.dictionary), data: compressed.toString("base64") });
    this.advance(bytes);
    return Buffer.byteLength(encoded) < bytes.length ? encoded : line;
  }

  decode(line: string, maximum: number, enabled: boolean): string {
    const record = JSON.parse(line) as Record<string, unknown>;
    let bytes: Buffer;
    if (record.version === 1) {
      bytes = Buffer.from(line, "utf8");
    } else {
      if (!enabled || record.version !== 2 || record.encoding !== CODEX_GAP_ENCODING
        || !Number.isSafeInteger(record.bytes) || Number(record.bytes) < 1 || Number(record.bytes) > maximum
        || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256)
        || record.dictionarySha256 !== digest(this.dictionary) || typeof record.data !== "string"
        || record.data.length > maximum * 2 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(record.data)) {
        throw new Error("compact_dictionary_identity_or_bounds");
      }
      const compressed = Buffer.from(record.data, "base64");
      if (compressed.toString("base64") !== record.data) throw new Error("compact_dictionary_encoding");
      bytes = inflateRawSync(compressed, { dictionary: this.dictionary, maxOutputLength: maximum });
      if (bytes.length !== record.bytes || digest(bytes) !== record.sha256) throw new Error("compact_dictionary_digest");
    }
    if (bytes.length > maximum) throw new Error("compact_dictionary_bounds");
    const restored = bytes.toString("utf8");
    if (!Buffer.from(restored, "utf8").equals(bytes)) throw new Error("compact_dictionary_utf8");
    this.advance(bytes);
    return restored;
  }
}
