import { revisionForRuntimeConfig } from "./runtime-kernel/native-session.js";

// Preserve the existing secret exclusions; execution/permission settings and
// provider paths remain part of the identity. Discovery is not an instruction.
const LEGACY_EXCLUDED_KEYS = ["apiKey", "authToken", "token", "password"];
const CODEX_METHODS = ["threadResume", "threadRead", "threadFork"];
const CODEX_PAGING_METHODS = ["threadItemsList", "threadTurnsList"];

export function chatBindingInstructionsRevision(input: {
  runtimeType: string;
  config: Record<string, unknown>;
  existingRevision?: string | null;
}): string {
  const legacyRevision = revisionForRuntimeConfig(input.config, LEGACY_EXCLUDED_KEYS);
  if (input.runtimeType !== "codex_local") return legacyRevision;

  const semanticRevision = `codex-chat-config-v1:${revisionForRuntimeConfig(
    input.config,
    [...LEGACY_EXCLUDED_KEYS, "nativeCapabilityMethods"],
  )}`;
  if (!input.existingRevision || input.existingRevision === semanticRevision) return semanticRevision;
  // A pre-upgrade binding whose full config is still identical needs no migration.
  if (input.existingRevision === legacyRevision) return input.existingRevision;

  const methods = input.config.nativeCapabilityMethods;
  if (methods && typeof methods === "object" && !Array.isArray(methods)) {
    const record = methods as Record<string, unknown>;
    const knownKeys = new Set([...CODEX_METHODS, ...CODEX_PAGING_METHODS]);
    if (CODEX_METHODS.every((key) => typeof record[key] === "boolean")
      && Object.keys(record).every((key) => knownKeys.has(key) && typeof record[key] === "boolean")) {
      // Reconstruct exactly the historical three-method layout. All other full
      // prepared-config fields are unchanged. Equality with the persisted hash
      // proves the alias; never infer equality from a partial profile snapshot.
      const historicalRevision = revisionForRuntimeConfig({
        ...input.config,
        nativeCapabilityMethods: Object.fromEntries(CODEX_METHODS.map((key) => [key, record[key]])),
      }, LEGACY_EXCLUDED_KEYS);
      if (input.existingRevision === historicalRevision) return input.existingRevision;
    }
  }
  // Unknown legacy layouts or real config drift use the ordinary binding
  // rotation path. No stored hash, old input, or historical Run is rewritten.
  return semanticRevision;
}
