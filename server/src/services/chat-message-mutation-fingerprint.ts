import type { ChatInlineAnnotationInput } from "@rudderhq/shared";
import { createHash } from "node:crypto";

type MutationFile = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size?: number;
};

export function chatMessageMutationFingerprint(input: {
  body: string;
  editUserMessageId?: string | null;
  inlineAnnotationsProvided: boolean;
  inlineAnnotations?: ChatInlineAnnotationInput[];
  modelOverride?: string | null;
  effortOverride?: string | null;
  files: readonly MutationFile[];
}) {
  return createHash("sha256")
    .update(JSON.stringify({
      body: input.body,
      editUserMessageId: input.editUserMessageId ?? null,
      inlineAnnotations: input.inlineAnnotationsProvided
        ? (input.inlineAnnotations ?? [])
        : null,
      modelOverride: input.modelOverride ?? null,
      effortOverride: input.effortOverride ?? null,
      files: input.files.map((file, index) => ({
        index,
        contentType: file.mimetype.toLowerCase(),
        byteSize: file.size ?? file.buffer.byteLength,
        sha256: createHash("sha256").update(file.buffer).digest("hex"),
        originalFilename: file.originalname || null,
      })),
    }))
    .digest("hex");
}
