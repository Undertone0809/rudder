import type {
  AgentRuntimeNetworkSuspension,
  AgentRuntimeNetworkTransport,
} from "./types.js";

export interface AgentRuntimeNetworkFailureEvidence {
  errorCode?: string | null;
  message?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  provider?: string | null;
  model?: string | null;
  sessionId?: string | null;
  sessionParams?: Record<string, unknown> | null;
  modelOutputObserved?: boolean;
  toolActivityObserved?: boolean;
  terminalEventObserved?: boolean;
}

const AUTH_OR_CREDENTIAL_RE =
  /\b(?:auth(?:entication)?|credential|login|logged\s+in|unauthori[sz]ed|invalid\s+(?:api[-_ ]?key|credential)|api[-_ ]?key|access\s+denied|\b401\b|\b403\b)\b/i;
const QUOTA_OR_LIMIT_RE =
  /\b(?:quota|rate[-\s]?limit|too\s+many\s+requests|resource[_\s-]?exhausted|usage\s+limit|billing|\b429\b|\b402\b)\b/i;
const CONFIG_OR_REQUEST_RE =
  /\b(?:invalid\s+(?:model|argument|request|parameter)|unknown\s+model|model\s+not\s+found|unsupported\s+model|bad\s+request|malformed|command\s+not\s+found|no\s+such\s+(?:file|directory)|permission\s+denied|\b400\b|\b404\b|\b405\b)\b/i;
const PROVIDER_FAILURE_RE =
  /\b(?:\b5\d\d\b|internal\s+server\s+error|service\s+unavailable|provider\s+error)\b/i;
const TOOL_OR_MCP_RE =
  /\b(?:mcp|tool|function[_ -]?call|browser|shell|command)\b[\s\S]{0,100}\b(?:network|connect(?:ion)?|dns|socket|timeout|fetch|unreachable|reset|closed)\b|\b(?:network|connect(?:ion)?|dns|socket|timeout|fetch|unreachable|reset|closed)\b[\s\S]{0,100}\b(?:mcp|tool|function[_ -]?call|browser|shell|command)\b/i;

const NETWORK_PATTERNS: Array<{ transport: AgentRuntimeNetworkTransport; pattern: RegExp }> = [
  {
    transport: "dns",
    pattern: /\b(?:enotfound|eai_again|err_name_not_resolved|name\s+resolution|getaddrinfo|dns\s+(?:lookup|failure|error))\b/i,
  },
  {
    transport: "stream_disconnect",
    pattern: /(?:stream\s+disconnected|stream\s+closed|connection\s+(?:reset|closed|aborted|dropped)|socket\s+(?:hang\s*up|closed|reset)|econnreset|econnaborted|broken\s+pipe|network\s+connection\s+(?:lost|closed)|fetch\s+failed)/i,
  },
  {
    transport: "timeout",
    pattern: /(?:\betimedout\b|\bconnect(?:ion)?\s+tim(?:e|ed)\s*out\b|\brequest\s+tim(?:e|ed)\s*out\b|network\s+timeout|deadline\s+exceeded)/i,
  },
  {
    transport: "connection",
    pattern: /(?:\beconnrefused\b|\bconnection\s+(?:refused|failed)\b|\bnetwork\s+unreachable\b|\bno\s+route\s+to\s+host\b|\btemporarily\s+unavailable\b)/i,
  },
];

function readEvidence(input: AgentRuntimeNetworkFailureEvidence): string {
  return [input.message, input.stdout, input.stderr].filter(Boolean).join("\n");
}

function inferTransport(evidence: string): AgentRuntimeNetworkTransport | null {
  for (const candidate of NETWORK_PATTERNS) {
    if (candidate.pattern.test(evidence)) return candidate.transport;
  }
  return null;
}

/**
 * Classify only model/provider transport failures. This deliberately remains
 * conservative: credentials, quota, request/configuration, provider 5xx, and
 * tool/MCP failures must continue through the normal terminal-failure path.
 */
export function classifyAgentRuntimeNetworkFailure(
  input: AgentRuntimeNetworkFailureEvidence,
): AgentRuntimeNetworkSuspension | null {
  const evidence = readEvidence(input);
  if (!evidence.trim()) return null;

  const errorCode = input.errorCode?.trim().toLowerCase() ?? "";
  if (
    /(?:auth|credential|login|quota|rate|limit|config|invalid[_-]?model|bad[_-]?request|provider[_-]?error)/i.test(errorCode)
    || AUTH_OR_CREDENTIAL_RE.test(evidence)
    || QUOTA_OR_LIMIT_RE.test(evidence)
    || CONFIG_OR_REQUEST_RE.test(evidence)
    || PROVIDER_FAILURE_RE.test(evidence)
    || input.toolActivityObserved === true
    || TOOL_OR_MCP_RE.test(evidence)
  ) {
    return null;
  }

  const transport = inferTransport(evidence);
  if (!transport) return null;

  const modelOutputObserved = input.modelOutputObserved === true;
  const toolActivityObserved = Boolean(input.toolActivityObserved);
  const hasSession = Boolean(input.sessionId?.trim());
  const terminalEventObserved = input.terminalEventObserved === true;
  const submissionPhase = toolActivityObserved || modelOutputObserved
    ? "accepted"
    : terminalEventObserved || hasSession
      ? "indeterminate"
      : "pre_submission";
  const continuation = hasSession
    ? "resume_same_session"
    : submissionPhase === "pre_submission"
      ? "fresh_if_pristine"
      : "fail_closed";
  const sideEffectRisk = toolActivityObserved
    ? "confirmed"
    : modelOutputObserved || submissionPhase === "indeterminate"
      ? "possible"
      : "none";

  return {
    kind: "network_unavailable",
    code: "provider_transport_unavailable",
    submissionPhase,
    continuation,
    transport,
    provider: input.provider ?? null,
    model: input.model ?? null,
    sessionId: input.sessionId ?? null,
    sessionParams: input.sessionParams ?? null,
    modelOutputObserved,
    toolActivityObserved,
    sideEffectRisk,
    message: input.message?.trim() || `${transport} transport unavailable`,
    progress: { modelOutputObserved, toolActivityObserved },
  };
}

export function isAgentRuntimeNetworkSuspension(
  value: unknown,
): value is AgentRuntimeNetworkSuspension {
  return Boolean(
    value
      && typeof value === "object"
      && (value as { kind?: unknown }).kind === "network_unavailable",
  );
}
