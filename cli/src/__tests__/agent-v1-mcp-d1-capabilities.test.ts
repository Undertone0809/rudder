import { describe, expect, it, vi } from "vitest";
import {
  dispatchD1CapabilityDirectly,
  organizationBrandColorCliArgs,
  projectUpdateCliArgs,
} from "../agent-v1-mcp-d1-capabilities.js";

function requiredString(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`Missing required argument: ${key}`);
}

function optionalString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function requiredRuntimeString(env: { RUDDER_ORG_ID?: string }, key: "RUDDER_ORG_ID") {
  const value = env[key]?.trim();
  if (value) return value;
  throw new Error(`Missing runtime context: ${key}`);
}

function pushOptional(args: string[], flag: string, value: unknown) {
  const rendered = optionalString(value);
  if (rendered) args.push(flag, rendered);
}

function createApi() {
  return {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ id: "project-1" }),
    patch: vi.fn().mockResolvedValue({ id: "project-1" }),
  };
}

describe("D1 MCP capability dispatch", () => {
  it("requires Rust authority and an idempotency key for organization branding", async () => {
    const api = createApi();
    const input = { brandColor: "#123456", idempotencyKey: "brand-1" };

    await dispatchD1CapabilityDirectly("organization.brand_color.update", input, {
      RUDDER_ORG_ID: "org / one",
    }, api as never, { requiredRuntimeString, requiredString, optionalString });

    expect(api.patch).toHaveBeenCalledWith(
      "/api/orgs/org%20%2F%20one/branding",
      { brandColor: "#123456" },
      { headers: {
        "x-rudder-idempotency-key": "brand-1",
        "x-rudder-required-authority": "rust",
      } },
    );
  });

  it("allowlists organization-scoped Project creation fields", async () => {
    const api = createApi();

    await dispatchD1CapabilityDirectly("project.create", {
      name: "Project",
      goalIds: ["goal-1"],
      ignored: true,
    }, { RUDDER_ORG_ID: "org/one" }, api as never, {
      requiredRuntimeString,
      requiredString,
      optionalString,
    });

    expect(api.post).toHaveBeenCalledWith("/api/orgs/org%2Fone/projects", {
      name: "Project",
      goalIds: ["goal-1"],
    });
  });

  it("always sends idempotency and requires Rust authority only when Project goals change", async () => {
    const api = createApi();

    await dispatchD1CapabilityDirectly("project.update", {
      project: "project/one",
      status: "active",
      goalIds: [],
      idempotencyKey: "project-goals-1",
    }, { RUDDER_ORG_ID: "org one" }, api as never, {
      requiredRuntimeString,
      requiredString,
      optionalString,
    });

    expect(api.patch).toHaveBeenCalledWith(
      "/api/projects/project%2Fone?orgId=org%20one",
      { status: "active", goalIds: [] },
      { headers: {
        "x-rudder-idempotency-key": "project-goals-1",
        "x-rudder-required-authority": "rust",
      } },
    );

    api.patch.mockClear();
    await dispatchD1CapabilityDirectly("project.update", {
      project: "project-1",
      status: "active",
    }, {}, api as never, { requiredRuntimeString, requiredString, optionalString });
    const scalarCall = api.patch.mock.calls[0] as unknown as [string, unknown, { headers: Record<string, string> }];
    expect(scalarCall[0]).toBe("/api/projects/project-1");
    expect(scalarCall[1]).toEqual({ status: "active" });
    expect(scalarCall[2].headers["x-rudder-idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(scalarCall[2].headers["x-rudder-required-authority"]).toBeUndefined();

    api.patch.mockClear();
    await dispatchD1CapabilityDirectly("project.update", {
      project: "project-1",
      status: "active",
      idempotencyKey: "project-scalar-1",
    }, {}, api as never, { requiredRuntimeString, requiredString, optionalString });
    expect(api.patch).toHaveBeenCalledWith(
      "/api/projects/project-1",
      { status: "active" },
      { headers: { "x-rudder-idempotency-key": "project-scalar-1" } },
    );
  });

  it("preserves Project CLI argument order when clearing its goal set", () => {
    const args = projectUpdateCliArgs({
      project: "project-1",
      name: "Project",
      goalIds: [],
      idempotencyKey: "clear-goals-1",
      leadAgentId: "agent-1",
      targetDate: "2026-10-01",
    }, {
      requiredAnyString: (input, keys) => requiredString(input, keys[0]),
      requiredString,
      optionalString,
      pushOptional,
    });

    expect(args).toEqual([
      "project", "update", "project-1", "--name", "Project",
      "--goal-ids", "",
      "--lead-agent-id", "agent-1",
      "--target-date", "2026-10-01",
      "--idempotency-key", "clear-goals-1",
    ]);
  });

  it("forwards an optional idempotency key for scalar Project CLI updates", () => {
    const args = projectUpdateCliArgs({
      project: "project-1",
      status: "active",
      idempotencyKey: "project-scalar-1",
    }, {
      requiredAnyString: (input, keys) => requiredString(input, keys[0]),
      requiredString,
      optionalString,
      pushOptional,
    });

    expect(args).toEqual([
      "project", "update", "project-1", "--status", "active",
      "--idempotency-key", "project-scalar-1",
    ]);
  });

  it.each([
    { goalId: "goal-1" },
    { goalIds: ["goal-1"] },
  ])("requires a stable key for Project-Goal CLI updates (%j)", (goalMutation) => {
    expect(() => projectUpdateCliArgs({ project: "project-1", ...goalMutation }, {
      requiredAnyString: (input, keys) => requiredString(input, keys[0]),
      requiredString,
      optionalString,
      pushOptional,
    })).toThrow("Missing required argument: idempotencyKey");
  });

  it("keeps the organization branding CLI fallback arguments", () => {
    expect(organizationBrandColorCliArgs({
      brandColor: "#123456",
      idempotencyKey: "brand-1",
    }, { RUDDER_ORG_ID: "org-1" }, requiredString, pushOptional)).toEqual([
      "org", "brand-color", "update",
      "--org-id", "org-1",
      "--brand-color", "#123456",
      "--idempotency-key", "brand-1",
    ]);
  });
});
