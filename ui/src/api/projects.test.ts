import { afterEach, describe, expect, it, vi } from "vitest";
import { projectsApi } from "./projects";

const idempotencyHeader = "x-rudder-idempotency-key";

const mutations = [
  {
    name: "update",
    invoke: (idempotencyKey?: string) => projectsApi.update(
      "project-1",
      { name: "Updated" },
      "org-1",
      idempotencyKey ? { idempotencyKey } : undefined,
    ),
  },
  {
    name: "attachResource",
    invoke: (idempotencyKey?: string) => projectsApi.attachResource(
      "project-1",
      { resourceId: "resource-1" },
      "org-1",
      idempotencyKey ? { idempotencyKey } : undefined,
    ),
  },
  {
    name: "updateResourceAttachment",
    invoke: (idempotencyKey?: string) => projectsApi.updateResourceAttachment(
      "project-1",
      "attachment-1",
      { note: "Updated" },
      "org-1",
      idempotencyKey ? { idempotencyKey } : undefined,
    ),
  },
  {
    name: "removeResourceAttachment",
    invoke: (idempotencyKey?: string) => projectsApi.removeResourceAttachment(
      "project-1",
      "attachment-1",
      "org-1",
      idempotencyKey ? { idempotencyKey } : undefined,
    ),
  },
] as const;

function stubResponse() {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("projectsApi mutation idempotency", () => {
  it.each(mutations)("generates one key for $name", async ({ invoke }) => {
    const randomUUID = vi.fn(() => "generated-project-key");
    vi.stubGlobal("crypto", { randomUUID });
    const fetchMock = stubResponse();

    await invoke();

    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(idempotencyHeader))
      .toBe("generated-project-key");
  });

  it.each(mutations)("preserves a caller-supplied key for $name", async ({ invoke }) => {
    const randomUUID = vi.fn(() => "unexpected-generated-key");
    vi.stubGlobal("crypto", { randomUUID });
    const fetchMock = stubResponse();

    await invoke("caller-project-key");

    expect(randomUUID).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(idempotencyHeader))
      .toBe("caller-project-key");
  });
});
