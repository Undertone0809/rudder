import {
  RUDDER_AGENT_CONTRACT,
  RUDDER_AGENT_CONTRACT_HASH,
} from "./rudder-agent-contract.generated.js";

export { RUDDER_AGENT_CONTRACT, RUDDER_AGENT_CONTRACT_HASH };
export const RUDDER_AGENT_CONTRACT_VERSION = RUDDER_AGENT_CONTRACT.contractVersion;

function decodeJsonPointerSegment(value: string): string {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

function replaceExistingPointer(root: unknown, pointer: string): void {
  if (!pointer.startsWith("/")) throw new Error(`Invalid contract normalization pointer: ${pointer}`);
  const segments = pointer.slice(1).split("/").map(decodeJsonPointerSegment);
  let cursor: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (!cursor || typeof cursor !== "object" || !(segment in cursor)) return;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  const leaf = segments.at(-1);
  if (!leaf || !cursor || typeof cursor !== "object" || !(leaf in cursor)) return;
  (cursor as Record<string, unknown>)[leaf] = "<non-semantic>";
}

export function normalizeRudderAgentContractValue(value: unknown, profile: string): unknown {
  const pointers = RUDDER_AGENT_CONTRACT.normalizationProfiles[
    profile as keyof typeof RUDDER_AGENT_CONTRACT.normalizationProfiles
  ];
  if (!pointers) throw new Error(`Unknown Rudder agent contract normalization profile: ${profile}`);
  const normalized = structuredClone(value);
  for (const pointer of pointers) replaceExistingPointer(normalized, pointer);
  return normalized;
}
