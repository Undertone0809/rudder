import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "./agents";

afterEach(() => vi.unstubAllGlobals());

describe("native runtime configuration check", () => {
  it.each(["codex_local", "hermes_local"])("checks %s in Rust and never falls back to a legacy probe", async (type) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "native_chat_unavailable" }), { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(agentsApi.testEnvironment("org-test", type, { agentRuntimeConfig: { profileId: "missing" } })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe("/api/orgs/org-test/native-chat/runtime-check");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ agentRuntimeType: type, agentRuntimeConfig: { profileId: "missing" } });
  });
});
