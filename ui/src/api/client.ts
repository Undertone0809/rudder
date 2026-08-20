const BASE = "/api";

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export class ApiTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "ApiTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export type ApiRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

type RequestSignal = {
  signal?: AbortSignal;
  didTimeout: () => boolean;
  clearTimeout: () => void;
  dispose: () => void;
};

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function createRequestSignal(options: ApiRequestOptions = {}): RequestSignal {
  const timeoutMs = options.timeoutMs;
  if (!timeoutMs || timeoutMs <= 0) {
    return {
      signal: options.signal,
      didTimeout: () => false,
      clearTimeout: () => undefined,
      dispose: () => undefined,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    onAbort();
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
  }
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort(new ApiTimeoutError(timeoutMs));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    clearTimeout: () => {
      globalThis.clearTimeout(timer);
    },
    dispose: () => {
      globalThis.clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    },
  };
}

function readErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const error = "error" in body ? (body as { error?: unknown }).error : undefined;
  const base = typeof error === "string" && error.trim() ? error.trim() : fallback;
  const details = "details" in body ? (body as { details?: unknown }).details : undefined;
  if (!Array.isArray(details)) return base;

  const detailMessages = details
    .map((detail) => {
      if (!detail || typeof detail !== "object") return null;
      const message = "message" in detail ? (detail as { message?: unknown }).message : undefined;
      if (typeof message !== "string" || !message.trim()) return null;
      const path = "path" in detail ? (detail as { path?: unknown }).path : undefined;
      const pathLabel = Array.isArray(path)
        ? path.filter((part) => typeof part === "string" || typeof part === "number").join(".")
        : "";
      return pathLabel ? `${pathLabel}: ${message.trim()}` : message.trim();
    })
    .filter((message): message is string => Boolean(message));

  return detailMessages.length > 0 ? `${base}: ${detailMessages.join("; ")}` : base;
}

async function request<T>(path: string, init?: RequestInit, options: ApiRequestOptions = {}): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  const body = init?.body;
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const requestSignal = createRequestSignal({
    signal: options.signal ?? init?.signal ?? undefined,
    timeoutMs: options.timeoutMs,
  });
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers,
      credentials: "include",
      ...init,
      signal: requestSignal.signal,
    });
  } catch (error) {
    if (requestSignal.didTimeout()) throw new ApiTimeoutError(options.timeoutMs!);
    throw error;
  } finally {
    requestSignal.dispose();
  }
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    throw new ApiError(
      readErrorMessage(errorBody, `Request failed: ${res.status}`),
      res.status,
      errorBody,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T>(path: string, init?: RequestInit, options?: ApiRequestOptions) => request<T>(path, init, options),
  post: <T>(path: string, body: unknown, options?: ApiRequestOptions) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body), signal: options?.signal }, options),
  postForm: <T>(path: string, body: FormData, options?: ApiRequestOptions) =>
    request<T>(path, { method: "POST", body, signal: options?.signal }, options),
  put: <T>(path: string, body: unknown, options?: ApiRequestOptions) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body), signal: options?.signal }, options),
  patch: <T>(path: string, body: unknown, options?: ApiRequestOptions) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body), signal: options?.signal }, options),
  delete: <T>(path: string, options?: ApiRequestOptions) =>
    request<T>(path, { method: "DELETE", signal: options?.signal }, options),
};
