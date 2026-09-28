export type OpenCodeNativeFailureDiagnostic = {
  runtime: "opencode_local";
  event: "session.error" | "message.error";
  source: "provider" | "adapter";
  errorName: string | null;
  statusCode: number | null;
  responseErrorType: string | null;
  messageClassification: "present" | "absent" | "rejected";
  message: string | null;
};

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(value.trim())
    ? value.trim()
    : null;
}

function safeMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const message = value.trim();
  if (!message || message.length > 300 || !/^[A-Za-z0-9 .,:;!?()/_+-]+$/u.test(message)) return null;
  if (/(?:https?:\/\/|\b(?:api[ _-]*key|token|password|secret|authorization|cookie|bearer|basic|credential)\b|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{4,}\b|@)/iu.test(message)) return null;
  if (/[A-Za-z0-9+/_=-]{28,}/u.test(message)) return null;
  return message;
}

function responseErrorType(value: unknown): string | null {
  let body = value;
  if (typeof body === "string") {
    if (body.length > 8_000) return null;
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  return safeIdentifier(asRecord(asRecord(body)?.error)?.type);
}

function sourceFor(errorName: string | null, responseType: string | null, statusCode: number | null) {
  return (errorName === "APIError" && statusCode !== null)
    || /^Provider[A-Za-z0-9]*Error$/u.test(errorName ?? "")
    || /^Provider[A-Za-z0-9]*Error$/u.test(responseType ?? "")
    ? "provider" as const
    : "adapter" as const;
}

function messageDiagnostic(candidates: unknown[], priorClassification?: unknown) {
  let rejected = priorClassification === "rejected";
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === "string") {
      if (!candidate.trim()) continue;
      const message = safeMessage(candidate);
      if (message) return { messageClassification: "present" as const, message };
    }
    rejected = true;
  }
  return {
    messageClassification: rejected || priorClassification === "present" ? "rejected" as const : "absent" as const,
    message: null,
  };
}

export function diagnoseOpenCodeNativeFailure(
  value: unknown,
  event: OpenCodeNativeFailureDiagnostic["event"] = "session.error",
): OpenCodeNativeFailureDiagnostic {
  const record = asRecord(value);
  const data = asRecord(record?.data);
  const errorName = safeIdentifier(record?.name);
  const statusCode = typeof data?.statusCode === "number"
    && Number.isInteger(data.statusCode)
    && data.statusCode >= 100
    && data.statusCode <= 599
    ? data.statusCode
    : null;
  const responseType = responseErrorType(data?.responseBody);
  const messages = messageDiagnostic([
    typeof value === "string" ? value : undefined,
    record?.message,
    typeof record?.error === "string" ? record.error : undefined,
    typeof record?.detail === "string" ? record.detail : undefined,
    data?.message,
  ]);

  return {
    runtime: "opencode_local",
    event,
    source: sourceFor(errorName, responseType, statusCode),
    errorName,
    statusCode,
    responseErrorType: responseType,
    ...messages,
  };
}

export function parseOpenCodeNativeFailureDiagnostic(value: unknown): OpenCodeNativeFailureDiagnostic | null {
  const record = asRecord(value);
  if (record?.runtime !== "opencode_local" || (record.event !== "session.error" && record.event !== "message.error")) return null;

  const errorName = safeIdentifier(record.errorName);
  const statusCode = typeof record.statusCode === "number"
    && Number.isInteger(record.statusCode)
    && record.statusCode >= 100
    && record.statusCode <= 599
    ? record.statusCode
    : null;
  const responseType = safeIdentifier(record.responseErrorType);
  const messages = messageDiagnostic([record.message], record.messageClassification);

  return {
    runtime: "opencode_local",
    event: record.event,
    source: sourceFor(errorName, responseType, statusCode),
    errorName,
    statusCode,
    responseErrorType: responseType,
    ...messages,
  };
}
