import { normalizeModelFallbacks, type CreateConfigValues } from "@rudderhq/agent-runtime-utils";

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function buildOpenClawGatewayConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;
  if (v.model) ac.model = v.model;
  const modelFallbacks = normalizeModelFallbacks(v.modelFallbacks, {
    agentRuntimeType: "openclaw_gateway",
    model: v.model,
  });
  if (modelFallbacks.length > 0) ac.modelFallbacks = modelFallbacks;
  // Keep this adapter consumable from older workspace type artifacts while
  // the shared CreateConfigValues type propagates through pnpm links.
  const authToken = (v as CreateConfigValues & { authToken?: string }).authToken;
  if (authToken) ac.authToken = authToken;
  ac.timeoutSec = 120;
  ac.waitTimeoutMs = 120000;
  ac.sessionKeyStrategy = "issue";
  ac.role = "operator";
  ac.scopes = ["operator.read", "operator.write"];
  const payloadTemplate = parseJsonObject(v.payloadTemplateJson ?? "");
  if (payloadTemplate) ac.payloadTemplate = payloadTemplate;
  const runtimeServices = parseJsonObject(v.runtimeServicesJson ?? "");
  if (runtimeServices && Array.isArray(runtimeServices.services)) {
    ac.workspaceRuntime = runtimeServices;
  }
  return ac;
}
