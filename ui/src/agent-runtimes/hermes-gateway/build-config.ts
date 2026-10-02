import { normalizeModelFallbacks, type CreateConfigValues } from "@rudderhq/agent-runtime-utils";

function parseObject(value: string): Record<string, unknown> | null {
  if (!value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function buildHermesGatewayConfig(values: CreateConfigValues): Record<string, unknown> {
  const customConnection = values.hermesConnectionMode === "custom";
  const config: Record<string, unknown> = {
    timeoutSec: 120,
    sessionKeyStrategy: "issue",
    hermesConnectionMode: customConnection ? "custom" : "local",
    ...(customConnection ? { hermesChatBackend: "native_runs_http" } : {}),
  };
  if (customConnection && values.url) config.url = values.url;
  if (values.model) config.model = values.model;
  const modelFallbacks = normalizeModelFallbacks(values.modelFallbacks, {
    agentRuntimeType: "hermes_gateway",
    model: values.model,
  });
  if (modelFallbacks.length > 0) config.modelFallbacks = modelFallbacks;
  if (customConnection && values.apiKey) config.apiKey = values.apiKey;
  const payload = customConnection ? parseObject(values.payloadTemplateJson ?? "") : null;
  if (payload) config.payloadTemplate = payload;
  return config;
}
