import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client errors", () => {
  it("includes validation detail messages in ApiError.message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: "Validation error",
            details: [
              {
                code: "custom",
                path: ["outputMode"],
                message: "Chat output automations are no longer supported",
              },
            ],
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    await expect(api.post("/orgs/org-1/automations", {})).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      message: "Validation error: outputMode: Chat output automations are no longer supported",
    } satisfies Partial<ApiError>);
  });
});
