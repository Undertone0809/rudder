import { createHash } from "node:crypto";
import { normalizeAgentUrlKey } from "@rudderhq/shared";

export const AGENT_WORKSPACE_SHORT_ID_MIN_LENGTH = 8;
export const AGENT_WORKSPACE_SHORT_ID_STEP = 4;

export type AgentWorkspaceLocator = {
  id: string;
  name?: string | null;
  workspaceKey?: string | null;
};

function normalizeAgentIdHex(agentId: string): string {
  return agentId.trim().toLowerCase().replace(/[^a-f0-9]/g, "");
}

function ensureAgentWorkspaceIdSeed(agentId: string): string {
  const normalized = normalizeAgentIdHex(agentId);
  if (normalized.length >= AGENT_WORKSPACE_SHORT_ID_MIN_LENGTH) {
    return normalized;
  }
  return createHash("sha1").update(agentId.trim()).digest("hex");
}

export function normalizeAgentWorkspaceSlug(value: string | null | undefined): string {
  return normalizeAgentUrlKey(value) ?? "agent";
}

export function extractAgentWorkspaceShortId(agentId: string, length = AGENT_WORKSPACE_SHORT_ID_MIN_LENGTH): string {
  const normalizedId = ensureAgentWorkspaceIdSeed(agentId);
  const safeLength = Math.max(
    AGENT_WORKSPACE_SHORT_ID_MIN_LENGTH,
    Math.min(length, normalizedId.length),
  );
  return normalizedId.slice(0, safeLength);
}

export function buildAgentWorkspaceKey(
  name: string | null | undefined,
  agentId: string,
  shortIdLength = AGENT_WORKSPACE_SHORT_ID_MIN_LENGTH,
): string {
  const slug = normalizeAgentWorkspaceSlug(name);
  const shortId = extractAgentWorkspaceShortId(agentId, shortIdLength);
  return `${slug}--${shortId}`;
}

export function deriveUniqueAgentWorkspaceKey(input: {
  agentId: string;
  name: string | null | undefined;
  existingKeys?: Iterable<string>;
}): string {
  const existingKeys = new Set(
    Array.from(input.existingKeys ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  const normalizedId = ensureAgentWorkspaceIdSeed(input.agentId);

  for (
    let length = AGENT_WORKSPACE_SHORT_ID_MIN_LENGTH;
    length <= normalizedId.length;
    length = length === normalizedId.length ? normalizedId.length + 1 : Math.min(normalizedId.length, length + AGENT_WORKSPACE_SHORT_ID_STEP)
  ) {
    const candidate = buildAgentWorkspaceKey(input.name, input.agentId, length);
    if (!existingKeys.has(candidate)) {
      return candidate;
    }
    if (length === normalizedId.length) break;
  }

  throw new Error(`Unable to allocate unique workspace key for agent "${input.agentId}".`);
}

export function resolveStoredOrDerivedAgentWorkspaceKey(agent: AgentWorkspaceLocator): string {
  const stored = agent.workspaceKey?.trim();
  if (stored) return stored;
  return buildAgentWorkspaceKey(agent.name, agent.id);
}
