import type { AgentRuntimeExecutionContext, AgentRuntimeExecutionResult } from "../types.js";
import { asNumber, asString, parseObject } from "../utils.js";

const MAX_HTTP_RUNTIME_RESPONSE_BYTES = 4 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function responseText(value: Record<string, unknown>): string | null {
  for (const key of ["text", "message", "content", "summary"] as const) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
}

async function readBoundedResponseBody(response: Response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HTTP_RUNTIME_RESPONSE_BYTES) {
    throw new Error(`HTTP runtime response exceeded ${MAX_HTTP_RUNTIME_RESPONSE_BYTES} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteSize += value.byteLength;
    if (byteSize > MAX_HTTP_RUNTIME_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`HTTP runtime response exceeded ${MAX_HTTP_RUNTIME_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(byteSize);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function execute(ctx: AgentRuntimeExecutionContext): Promise<AgentRuntimeExecutionResult> {
  const { config, runId, agent, context, abortSignal } = ctx;
  const url = asString(config.url, "");
  if (!url) throw new Error("HTTP adapter missing url");

  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, 0);
  const headers = parseObject(config.headers) as Record<string, string>;
  const payloadTemplate = parseObject(config.payloadTemplate);
  const body = { ...payloadTemplate, agentId: agent.id, runId, context };

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const abortFromContext = () => controller.abort();
  if (abortSignal?.aborted) controller.abort();
  else abortSignal?.addEventListener("abort", abortFromContext, { once: true });

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      ...((timer || abortSignal) ? { signal: controller.signal } : {}),
    });

    if (!res.ok) {
      throw new Error(`HTTP invoke failed with status ${res.status}`);
    }

    const rawBody = await readBoundedResponseBody(res);
    let parsedBody: Record<string, unknown> | null = null;
    if (rawBody.trim().length > 0) {
      try {
        parsedBody = asRecord(JSON.parse(rawBody));
      } catch {
        parsedBody = null;
      }
    }
    const text = parsedBody ? responseText(parsedBody) : rawBody.trim() || null;

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      ...(text ? { summary: text } : {}),
      resultJson: parsedBody ?? (text ? { text } : null),
    };
  } finally {
    if (timer) clearTimeout(timer);
    abortSignal?.removeEventListener("abort", abortFromContext);
  }
}
