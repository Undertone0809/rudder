import { describe, expect, it } from "vitest";
import { hasAgentShortnameCollision, deduplicateAgentName } from "../services/agents.ts";
import { AGENT_NAME_POOL, pickUniqueAgentName } from "../services/agent-name-pool.ts";

describe("hasAgentShortnameCollision", () => {
  it("detects collisions by normalized shortname", () => {
    const collision = hasAgentShortnameCollision("Codex Coder", [
      { id: "a1", name: "codex-coder", status: "idle" },
    ]);
    expect(collision).toBe(true);
  });

  it("ignores terminated agents", () => {
    const collision = hasAgentShortnameCollision("Codex Coder", [
      { id: "a1", name: "codex-coder", status: "terminated" },
    ]);
    expect(collision).toBe(false);
  });

  it("ignores the excluded agent id", () => {
    const collision = hasAgentShortnameCollision(
      "Codex Coder",
      [
        { id: "a1", name: "codex-coder", status: "idle" },
        { id: "a2", name: "other-agent", status: "idle" },
      ],
      { excludeAgentId: "a1" },
    );
    expect(collision).toBe(false);
  });

  it("does not collide when candidate has no shortname", () => {
    const collision = hasAgentShortnameCollision("!!!", [
      { id: "a1", name: "codex-coder", status: "idle" },
    ]);
    expect(collision).toBe(false);
  });
});

describe("deduplicateAgentName", () => {
  it("returns original name when no collision", () => {
    const name = deduplicateAgentName("OpenClaw", [
      { id: "a1", name: "other-agent", status: "idle" },
    ]);
    expect(name).toBe("OpenClaw");
  });

  it("appends suffix when name collides", () => {
    const name = deduplicateAgentName("OpenClaw", [
      { id: "a1", name: "openclaw", status: "idle" },
    ]);
    expect(name).toBe("OpenClaw 2");
  });

  it("increments suffix until unique", () => {
    const name = deduplicateAgentName("OpenClaw", [
      { id: "a1", name: "openclaw", status: "idle" },
      { id: "a2", name: "openclaw-2", status: "idle" },
      { id: "a3", name: "openclaw-3", status: "idle" },
    ]);
    expect(name).toBe("OpenClaw 4");
  });

  it("ignores terminated agents for collision", () => {
    const name = deduplicateAgentName("OpenClaw", [
      { id: "a1", name: "openclaw", status: "terminated" },
    ]);
    expect(name).toBe("OpenClaw");
  });
});

describe("pickUniqueAgentName", () => {
  it("ships a 200-name pool for auto-assigned agents", () => {
    expect(AGENT_NAME_POOL).toHaveLength(200);
  });

  it("skips names already used by active agents", () => {
    const name = pickUniqueAgentName(
      [{ id: "a1", name: "Ada", status: "idle" }],
      { pickIndex: () => 0 },
    );
    expect(name).toBe("Aiden");
  });

  it("falls back to the full pool once every pool name is already taken", () => {
    const existingAgents = AGENT_NAME_POOL.map((name, index) => ({
      id: `a${index + 1}`,
      name,
      status: "idle",
    }));
    const name = pickUniqueAgentName(existingAgents, { pickIndex: () => 0 });
    expect(name).toBe("Ada");
  });
});
