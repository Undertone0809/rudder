import type {
  AgentRuntimeEnvironmentCheck,
  AgentRuntimeEnvironmentTestContext,
  AgentRuntimeEnvironmentTestResult,
} from "@rudderhq/agent-runtime-utils";
import { asString, parseObject } from "@rudderhq/agent-runtime-utils/server-utils";
import { asRecord, baseUrl, endpoint, hasBearerAuth, HERMES_SUPPORTED_VERSIONS, preflightBaseUrl, requestJson } from "./http.js";

function status(checks: AgentRuntimeEnvironmentCheck[]): AgentRuntimeEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function versionOf(value: unknown): string | null {
  const match = String(value ?? "").trim().match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

function endpointPath(capabilities: Record<string, unknown>, name: string): string | null {
  const endpointMap = asRecord(capabilities.endpoints);
  const entry = asRecord(endpointMap?.[name]);
  return typeof entry?.path === "string" ? entry.path : null;
}

const REQUIRED_ENDPOINTS: Record<string, string> = {
  runs: "/v1/runs",
  run_status: "/v1/runs/{run_id}",
  run_events: "/v1/runs/{run_id}/events",
  run_approval: "/v1/runs/{run_id}/approval",
  run_stop: "/v1/runs/{run_id}/stop",
  sessions: "/api/sessions",
  session_create: "/api/sessions",
  session: "/api/sessions/{session_id}",
  session_messages: "/api/sessions/{session_id}/messages",
};

export async function testEnvironment(
  ctx: AgentRuntimeEnvironmentTestContext,
): Promise<AgentRuntimeEnvironmentTestResult> {
  const checks: AgentRuntimeEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const configured = asString(config.url, "").trim();
  const base = baseUrl(configured);
  if (!configured) {
    checks.push({ code: "hermes_gateway_url_missing", level: "error", message: "Hermes API Server URL is required." });
  } else if (!base) {
    checks.push({ code: "hermes_gateway_url_invalid", level: "error", message: "Hermes URL must be an http(s) loopback endpoint without userinfo, query, or fragment." });
  } else {
    checks.push({ code: "hermes_gateway_url_valid", level: "info", message: `Configured Hermes API Server: ${base.toString()}` });
    const timeoutMs = 5_000;
    const preflight = await preflightBaseUrl(base);
    if (!preflight.ok) {
      checks.push({ code: "hermes_gateway_endpoint_rejected", level: "error", message: preflight.reason });
      return { agentRuntimeType: ctx.agentRuntimeType, status: status(checks), checks, testedAt: new Date().toISOString() };
    }
    if (!hasBearerAuth(config)) {
      checks.push({ code: "hermes_gateway_bearer_missing", level: "error", message: "Hermes API Server requires an explicit Bearer API key." });
      return { agentRuntimeType: ctx.agentRuntimeType, status: status(checks), checks, testedAt: new Date().toISOString() };
    }
    try {
      const health = await requestJson(endpoint(base, "/health"), config, {}, timeoutMs);
      if (!health.response.ok) {
        checks.push({ code: "hermes_gateway_health_failed", level: "error", message: `Hermes health returned HTTP ${health.response.status}.` });
      } else {
        const version = versionOf(health.body.version);
        if (!version || !(HERMES_SUPPORTED_VERSIONS as readonly string[]).includes(version)) {
          checks.push({ code: "hermes_gateway_version_unsupported", level: "error", message: `Hermes version ${version ?? "unknown"} is not in the supported compatibility matrix.` });
        } else {
          checks.push({ code: "hermes_gateway_health_ok", level: "info", message: `Hermes API Server is healthy (version ${version}).` });
        }
      }
    } catch (error) {
      checks.push({ code: "hermes_gateway_health_unreachable", level: "error", message: error instanceof Error ? error.message : "Hermes health probe failed." });
    }
    try {
      const detailed = await requestJson(endpoint(base, "/health/detailed"), config, {}, timeoutMs);
      if (!detailed.response.ok) {
        checks.push({ code: "hermes_gateway_health_detailed_failed", level: "error", message: `Hermes detailed health returned HTTP ${detailed.response.status}.` });
      } else {
        const runtime = asRecord(detailed.body.readiness) ?? asRecord(detailed.body.runtime);
        if (runtime && typeof runtime.mode === "string" && runtime.mode !== "server_agent") {
          checks.push({ code: "hermes_gateway_runtime_mode_unsupported", level: "error", message: `Hermes runtime mode ${runtime.mode} is not server_agent.` });
        } else {
          checks.push({ code: "hermes_gateway_health_detailed_ok", level: "info", message: "Hermes detailed readiness probe succeeded." });
        }
      }
    } catch (error) {
      checks.push({ code: "hermes_gateway_health_detailed_unreachable", level: "error", message: error instanceof Error ? error.message : "Hermes detailed health probe failed." });
    }

    try {
      const capabilities = await requestJson(endpoint(base, "/v1/capabilities"), config, {}, timeoutMs);
      if (!capabilities.response.ok) {
        checks.push({ code: "hermes_gateway_capabilities_failed", level: "error", message: `Hermes capabilities returned HTTP ${capabilities.response.status}.` });
      } else {
        const features = asRecord(capabilities.body.features) ?? {};
        const required = ["run_submission", "run_status", "run_events_sse", "run_stop", "run_approval_response", "session_resources"];
        const missing = required.filter((key) => features[key] !== true);
        const runtime = asRecord(capabilities.body.runtime);
        if (runtime?.tool_execution !== "server") missing.push("tool_execution:server");
        const missingEndpoints = Object.entries(REQUIRED_ENDPOINTS).filter(([key, path]) => endpointPath(capabilities.body, key) !== path).map(([key]) => key);
        if (missing.length > 0 || missingEndpoints.length > 0) {
          checks.push({ code: "hermes_gateway_capabilities_incomplete", level: "error", message: `Hermes API Server is missing required capabilities: ${[...missing, ...missingEndpoints.map((key) => `endpoint:${key}`)].join(", ")}.` });
        } else {
          checks.push({ code: "hermes_gateway_capabilities_ok", level: "info", message: "Hermes Runs, events, approval, stop, and session capabilities are available." });
        }
      }
    } catch (error) {
      checks.push({ code: "hermes_gateway_capabilities_unreachable", level: "error", message: error instanceof Error ? error.message : "Hermes capabilities probe failed." });
    }

    try {
      const models = await requestJson(endpoint(base, "/v1/models"), config, {}, timeoutMs);
      if (!models.response.ok) {
        checks.push({ code: "hermes_gateway_models_failed", level: "warn", message: `Hermes models returned HTTP ${models.response.status}.` });
      } else {
        checks.push({ code: "hermes_gateway_models_ok", level: "info", message: "Hermes model discovery succeeded." });
      }
    } catch (error) {
      checks.push({ code: "hermes_gateway_models_unreachable", level: "warn", message: error instanceof Error ? error.message : "Hermes models probe failed." });
    }
  }
  return { agentRuntimeType: ctx.agentRuntimeType, status: status(checks), checks, testedAt: new Date().toISOString() };
}
