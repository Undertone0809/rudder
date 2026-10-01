import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import type { RuntimeProviderBindingRef } from "./runtime-kernel/provider-capabilities.js";
import type { NativeTranscriptReadInput } from "./runtime-kernel/transcript-reader.contracts.js";

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cwdFrom(value: unknown): string | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? stringValue((value as Record<string, unknown>).cwd)
    : null;
}

/** Recover a historical Hermes cwd only when persisted, server-owned identities agree. */
export function historicalHermesManagedCwd(input: {
  runId: string;
  orgId: string;
  agentId: string;
  agentWorkspaceKey: string | null | undefined;
  runtimeBindingId: string | null;
  persistedRunCwd: string | null;
  binding: RuntimeProviderBindingRef | null | undefined;
  readerInput: NativeTranscriptReadInput;
}): string | null {
  const { binding: providerBinding, readerInput, runId, orgId, agentId } = input;
  const binding = readerInput.binding;
  const { span, segment } = readerInput;
  const workspaceKey = stringValue(input.agentWorkspaceKey);
  if (!workspaceKey || !agentId || !binding?.workspaceBindingId
    || readerInput.orgId !== orgId || readerInput.run.id !== runId || readerInput.run.orgId !== orgId
    || binding.orgId !== orgId || binding.agentId !== agentId || binding.runtimeType !== "hermes_gateway"
    || binding.id !== input.runtimeBindingId || binding.id !== span.bindingId
    || span.runId !== runId || span.orgId !== orgId
    || !segment || segment.id !== span.segmentId || segment.bindingId !== binding.id
    || segment.orgId !== orgId || providerBinding?.id !== binding.id
    || providerBinding.orgId !== orgId || providerBinding.workspaceBindingId !== binding.workspaceBindingId) return null;

  let managedCwd: string;
  try {
    managedCwd = resolveDefaultAgentWorkspaceDir(orgId, workspaceKey);
  } catch {
    return null;
  }
  return binding.workspaceBindingId === managedCwd
    && input.persistedRunCwd === managedCwd
    && cwdFrom(readerInput.run.sessionParamsAfterJson) === managedCwd
    ? managedCwd : null;
}
