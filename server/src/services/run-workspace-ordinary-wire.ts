import type { RustFoundationActor } from "./rust-foundation-bridge.js";

/** Encode the ordinary PATCH command before its exact bytes are signed. */
export function encodeRunWorkspaceOrdinaryUpdate(
  actor: RustFoundationActor,
  input: Record<string, unknown>,
): Buffer {
  // Match postgres.js TEXT encoding, while preserving JSONB's own Unicode
  // rejection after target lookup and authorization in the Rust transaction.
  const patch = input.input && typeof input.input === "object" && !Array.isArray(input.input)
    ? { ...input.input as Record<string, unknown> } : input.input;
  let metadataJsonBase64: string | undefined;
  let metadataSerializationFailed: true | undefined;
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    const fields = patch as Record<string, unknown>;
    if (typeof fields.cleanupReason === "string") {
      fields.cleanupReason = Buffer.from(fields.cleanupReason, "utf8").toString("utf8");
    }
    if (Object.hasOwn(fields, "metadata")) {
      let metadataJson = "";
      try { metadataJson = JSON.stringify(fields.metadata); }
      catch (error) {
        if (!(error instanceof RangeError)) throw error;
        metadataSerializationFailed = true;
      }
      // Only JSON.stringify's RangeError represents the legacy JSONB
      // encoding failure. Allocation, signing and transport errors retain
      // their own failure path.
      if (!metadataSerializationFailed) metadataJsonBase64 = Buffer.from(metadataJson, "utf8").toString("base64");
      fields.metadata = null;
    }
  }
  return Buffer.from(JSON.stringify({ ...input, input: patch, metadataJsonBase64, metadataSerializationFailed, actorRunId: actor.runId ?? null,
    credentialExpiresAt: actor.credentialExpiresAt ?? null,
    authenticatedOrgId: actor.orgId ?? actor.companyId ?? null,
    localImplicit: actor.type === "board" && actor.source === "local_implicit" }), "utf8");
}
