import { describe, expect, it } from "vitest";
import { AGENT_RUN_CONCURRENCY_DEFAULT } from "@rudderhq/shared";
import { defaultCreateValues } from "./agent-config-defaults";

describe("agent config defaults", () => {
  it("defaults new agents to three concurrent runs", () => {
    expect(defaultCreateValues.maxConcurrentRuns).toBe(AGENT_RUN_CONCURRENCY_DEFAULT);
    expect(defaultCreateValues.maxConcurrentRuns).toBe(3);
  });
});
