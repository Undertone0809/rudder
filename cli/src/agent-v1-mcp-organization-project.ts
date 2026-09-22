import type { McpServerEnv } from "./agent-v1-mcp-server.js";
import type { RudderApiClient } from "./client/http.js";

type DirectResult = Record<string, unknown>;

type DirectCallContext = {
  capabilityId: string;
  input: Record<string, unknown>;
  env: McpServerEnv;
  api: RudderApiClient;
  success: (data: unknown) => DirectResult;
  requiredRuntimeString: (env: McpServerEnv, key: keyof McpServerEnv) => string;
  requiredString: (input: Record<string, unknown>, key: string) => string;
  optionalString: (value: unknown) => string | null;
  appendOptionalQuery: (params: URLSearchParams, key: string, value: unknown) => void;
  parsePositiveInteger: (value: unknown, fallback: number) => number;
};

export async function callOrganizationProjectToolDirectly(
  context: DirectCallContext,
): Promise<DirectResult | null> {
  const {
    capabilityId,
    input,
    env,
    api,
    success,
    requiredRuntimeString,
    requiredString,
    optionalString,
    appendOptionalQuery,
    parsePositiveInteger,
  } = context;
  switch (capabilityId) {
    case "organization.members.list": {
      const orgId = requiredRuntimeString(env, "RUDDER_ORG_ID");
      const params = new URLSearchParams();
      appendOptionalQuery(params, "query", input.query);
      appendOptionalQuery(params, "type", input.type ?? "all");
      params.set("limit", String(parsePositiveInteger(input.limit, 50)));
      appendOptionalQuery(params, "cursor", input.cursor);
      return success(await api.get(`/api/orgs/${encodeURIComponent(orgId)}/members/directory?${params}`));
    }
    case "organization.brand_color.update": {
      const orgId = requiredRuntimeString(env, "RUDDER_ORG_ID");
      return success(await api.patch(
        `/api/orgs/${encodeURIComponent(orgId)}/branding`,
        { brandColor: requiredString(input, "brandColor") },
        { headers: {
          "x-rudder-idempotency-key": requiredString(input, "idempotencyKey"),
          "x-rudder-required-authority": "rust",
        } },
      ));
    }
    case "project.create": {
      const orgId = requiredRuntimeString(env, "RUDDER_ORG_ID");
      const payload: Record<string, unknown> = { name: requiredString(input, "name") };
      for (const key of ["description", "status", "goalId", "goalIds", "leadAgentId", "targetDate", "color"]) {
        if (input[key] !== undefined) payload[key] = input[key];
      }
      return success(await api.post(`/api/orgs/${encodeURIComponent(orgId)}/projects`, payload));
    }
    case "project.update": {
      const project = requiredString(input, "project");
      const payload: Record<string, unknown> = {};
      for (const key of ["name", "description", "status", "goalId", "goalIds", "leadAgentId", "targetDate", "color", "archivedAt"]) {
        if (input[key] !== undefined) payload[key] = input[key];
      }
      const headers: Record<string, string> = {};
      if (input.goalIds !== undefined || input.goalId !== undefined) {
        headers["x-rudder-idempotency-key"] = requiredString(input, "idempotencyKey");
        headers["x-rudder-required-authority"] = "rust";
      }
      const orgId = optionalString(env.RUDDER_ORG_ID);
      const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
      return success(await api.patch(
        `/api/projects/${encodeURIComponent(project)}${query}`,
        payload,
        Object.keys(headers).length > 0 ? { headers } : undefined,
      ));
    }
    default:
      return null;
  }
}

type CliArgumentContext = {
  capabilityId: string;
  input: Record<string, unknown>;
  env: McpServerEnv;
  requiredString: (input: Record<string, unknown>, key: string) => string;
  requiredAnyString: (input: Record<string, unknown>, keys: string[]) => string;
  pushOptional: (args: string[], flag: string, value: unknown) => void;
};

function optionalString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function pushCsvOptionPreservingEmpty(
  args: string[],
  flag: string,
  value: unknown,
  pushOptional: CliArgumentContext["pushOptional"],
): void {
  if (Array.isArray(value)) {
    const items = value.map((entry) => optionalString(entry)).filter((entry): entry is string => Boolean(entry));
    args.push(flag, items.join(","));
    return;
  }
  pushOptional(args, flag, value);
}

export function organizationProjectCliArgs(context: CliArgumentContext): string[] | null {
  const { capabilityId, input, env, requiredString, requiredAnyString, pushOptional } = context;
  switch (capabilityId) {
    case "organization.members.list": {
      const args = ["org", "members"];
      pushOptional(args, "--org-id", env.RUDDER_ORG_ID);
      pushOptional(args, "--query", input.query);
      pushOptional(args, "--type", input.type ?? "all");
      pushOptional(args, "--limit", input.limit);
      pushOptional(args, "--cursor", input.cursor);
      return args;
    }
    case "organization.brand_color.update": {
      const args = ["org", "brand-color", "update"];
      pushOptional(args, "--org-id", env.RUDDER_ORG_ID);
      args.push("--brand-color", requiredString(input, "brandColor"));
      args.push("--idempotency-key", requiredString(input, "idempotencyKey"));
      return args;
    }
    case "project.create": {
      const args = ["project", "create", "--name", requiredString(input, "name")];
      pushOptional(args, "--description", input.description);
      pushOptional(args, "--status", input.status);
      pushOptional(args, "--goal-id", input.goalId);
      pushOptional(args, "--goal-ids", input.goalIds);
      pushOptional(args, "--lead-agent-id", input.leadAgentId);
      pushOptional(args, "--target-date", input.targetDate);
      pushOptional(args, "--color", input.color);
      return args;
    }
    case "project.update": {
      const args = ["project", "update", requiredAnyString(input, ["project", "projectId"])];
      pushOptional(args, "--name", input.name);
      pushOptional(args, "--description", input.description);
      pushOptional(args, "--status", input.status);
      pushOptional(args, "--goal-id", input.goalId);
      pushCsvOptionPreservingEmpty(args, "--goal-ids", input.goalIds, pushOptional);
      pushOptional(args, "--lead-agent-id", input.leadAgentId);
      pushOptional(args, "--target-date", input.targetDate);
      pushOptional(args, "--color", input.color);
      pushOptional(args, "--archived-at", input.archivedAt);
      if (input.goalIds !== undefined || input.goalId !== undefined) {
        args.push("--idempotency-key", requiredString(input, "idempotencyKey"));
      }
      return args;
    }
    default:
      return null;
  }
}
