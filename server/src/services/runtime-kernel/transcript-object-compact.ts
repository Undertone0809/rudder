import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";

export const CODEX_GAP_ENCODING = "codex-gap-dictionary-v1";
const DICTIONARY_BYTES = 32 * 1024;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

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
