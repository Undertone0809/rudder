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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  const body = init?.body;
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${BASE}${path}`, {
    headers,
    credentials: "include",
    ...init,
  });
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
  get: <T>(path: string, init?: RequestInit) => request<T>(path, init),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  postForm: <T>(path: string, body: FormData) =>
    request<T>(path, { method: "POST", body }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
