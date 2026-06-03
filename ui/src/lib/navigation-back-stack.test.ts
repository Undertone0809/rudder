import { describe, expect, it } from "vitest";
import {
  isRedirectOnlyBackStackEntry,
  resolveInAppBackStackTargetIndex,
} from "./navigation-back-stack";

describe("navigation back stack", () => {
  it("skips bare agent redirect entries when leaving canonical agent detail routes", () => {
    const stack = [
      "/LIB/library?path=docs%2Fagent-link.md",
      "/LIB/agents/9f50d567-3df9-4a63-8ffc-2f0c9293ef16",
      "/LIB/agents/asher/dashboard",
    ];

    expect(resolveInAppBackStackTargetIndex(stack)).toBe(0);
  });

  it("does not skip real agent detail routes", () => {
    const stack = [
      "/LIB/agents/bob/dashboard",
      "/LIB/agents/asher/dashboard",
    ];

    expect(resolveInAppBackStackTargetIndex(stack)).toBe(0);
    expect(isRedirectOnlyBackStackEntry(stack[1], stack[0])).toBe(false);
  });

  it("does not skip a different agent's bare route as redirect-only history", () => {
    const stack = [
      "/LIB/dashboard",
      "/LIB/agents/bob",
      "/LIB/agents/asher/dashboard",
    ];

    expect(resolveInAppBackStackTargetIndex(stack)).toBe(1);
    expect(isRedirectOnlyBackStackEntry(stack[2], stack[1])).toBe(false);
  });

  it("skips same-agent bare canonical routes", () => {
    const stack = [
      "/LIB/agents",
      "/LIB/agents/asher",
      "/LIB/agents/asher/dashboard",
    ];

    expect(resolveInAppBackStackTargetIndex(stack)).toBe(0);
  });

  it("keeps redirect entries scoped to the same organization prefix", () => {
    expect(isRedirectOnlyBackStackEntry("/ACME/agents/asher/dashboard", "/OTHER/agents/agent-id")).toBe(false);
    expect(isRedirectOnlyBackStackEntry(
      "/agents/asher/dashboard",
      "/agents/9f50d567-3df9-4a63-8ffc-2f0c9293ef16",
    )).toBe(true);
  });
});
