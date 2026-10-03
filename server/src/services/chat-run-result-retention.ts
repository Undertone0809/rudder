import { createHash } from "node:crypto";

const MAX_NATIVE_CHAT_REPLY_CHARS = 2_000;

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function retainNativeChatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
  spanId: string,
): Record<string, unknown> {
  const source = resultJson && typeof resultJson === "object" && !Array.isArray(resultJson) ? resultJson : {};
  const body = typeof source.body === "string" ? source.body : null;
  const retainedBody = body?.slice(0, MAX_NATIVE_CHAT_REPLY_CHARS) ?? null;
  return {
    ...(nonEmptyText(source.outcome) ? { outcome: nonEmptyText(source.outcome) } : {}),
    ...(nonEmptyText(source.kind) ? { kind: nonEmptyText(source.kind) } : {}),
    ...(body !== null ? {
      body: retainedBody,
      productReply: {
        textStored: true,
        characterLength: body.length,
        utf8ByteLength: Buffer.byteLength(body, "utf8"),
        sha256: createHash("sha256").update(body, "utf8").digest("hex"),
        truncated: body.length > MAX_NATIVE_CHAT_REPLY_CHARS,
      },
    } : {}),
    ...(typeof source.generatedAttachmentCount === "number"
      && Number.isFinite(source.generatedAttachmentCount)
      ? { generatedAttachmentCount: source.generatedAttachmentCount }
      : {}),
    retention: {
      transcriptSource: "native",
      transcriptSpanId: spanId,
      rawTranscriptPersisted: false,
      rawTranscriptEventPersisted: false,
      rawLogPersisted: false,
      rawResultPersisted: false,
      productReplyStored: body !== null,
      productReplyTruncated: body !== null && body.length > MAX_NATIVE_CHAT_REPLY_CHARS,
    },
  };
}
