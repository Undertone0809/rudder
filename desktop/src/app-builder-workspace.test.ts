import { describe, expect, it, vi } from "vitest";
import { resolveAppBuilderWorkspaceRoot } from "./app-builder-workspace.js";

describe("App Builder workspace resolution", () => {
  it("uses the Electron session credentials for the protected workspace route", async () => {
    const fetchApi = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe(
        "http://127.0.0.1:3200/api/orgs/org-1/workspace/files",
      );
      expect(init?.credentials).toBe("include");
      expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
      return new Response(JSON.stringify({ rootPath: "/Users/zeeland/apps" }), { status: 200 });
    });

    await expect(resolveAppBuilderWorkspaceRoot({
      apiBaseUrl: "http://127.0.0.1:3200",
      organizationId: "org-1",
      fetchApi,
    })).resolves.toBe("/Users/zeeland/apps");
  });

  it("rejects a failed workspace request", async () => {
    const fetchApi = vi.fn(async () => new Response(null, { status: 401 }));

    await expect(resolveAppBuilderWorkspaceRoot({
      apiBaseUrl: "http://127.0.0.1:3200",
      organizationId: "org-1",
      fetchApi,
    })).rejects.toThrow("Unable to resolve the App Builder workspace (401)");
  });
});
