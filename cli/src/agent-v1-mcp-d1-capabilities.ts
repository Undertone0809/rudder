import { randomUUID } from "node:crypto";
import type { RudderApiClient } from "./client/http.js";

type D1RuntimeEnv = { RUDDER_ORG_ID?: string };
type DirectApi = Pick<RudderApiClient, "get" | "post" | "patch">;
type DirectHelpers = {
  requiredRuntimeString: (env: D1RuntimeEnv, key: "RUDDER_ORG_ID") => string;
  requiredString: (input: Record<string, unknown>, key: string) => string;
  optionalString: (value: unknown) => string | null;
};
type CliHelpers = {
  requiredAnyString: (input: Record<string, unknown>, keys: string[]) => string;
  requiredString: (input: Record<string, unknown>, key: string) => string;
  optionalString: (value: unknown) => string | null;
  pushOptional: (args: string[], flag: string, value: unknown) => void;
};

function normalizedBrandingValue(field: "brandColor" | "logoAssetId", value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid branding argument: ${field}`);
  }
  const trimmed = value.trim();
  return field === "logoAssetId" ? trimmed.toLowerCase() : trimmed;
}

export async function dispatchD1CapabilityDirectly(
  capabilityId: string,
  input: Record<string, unknown>,
  env: D1RuntimeEnv,
  api: DirectApi,
  helpers: DirectHelpers,
): Promise<{ data: unknown } | null> {
  const { optionalString, requiredRuntimeString, requiredString } = helpers;
  switch (capabilityId) {
    case "organization.brand_color.update": {
      const orgId = requiredRuntimeString(env, "RUDDER_ORG_ID");
      const patch: Record<string, unknown> = {};
      for (const field of ["brandColor", "logoAssetId"] as const) {
        if (!Object.prototype.hasOwnProperty.call(input, field) || input[field] === undefined) continue;
        const value = input[field];
        if (value === null) {
          patch[field] = null;
          continue;
        }
        patch[field] = normalizedBrandingValue(field, value);
      }
      if (Object.keys(patch).length === 0) {
        throw new Error("Provide brandColor or logoAssetId to update");
      }
      return { data: await api.patch(
        `/api/orgs/${encodeURIComponent(orgId)}/branding`,
        patch,
        { headers: {
          "x-rudder-idempotency-key": requiredString(input, "idempotencyKey"),
          "x-rudder-required-authority": "rust",
        } },
      ) };
    }
    case "project.create": {
      const orgId = requiredRuntimeString(env, "RUDDER_ORG_ID");
      const payload: Record<string, unknown> = { name: requiredString(input, "name") };
      for (const key of ["description", "status", "goalId", "goalIds", "leadAgentId", "targetDate", "color"]) {
        if (input[key] !== undefined) payload[key] = input[key];
      }
      return { data: await api.post(`/api/orgs/${encodeURIComponent(orgId)}/projects`, payload) };
    }
    case "project.update": {
      const project = requiredString(input, "project");
      const payload: Record<string, unknown> = {};
      for (const key of ["name", "description", "status", "goalId", "goalIds", "leadAgentId", "targetDate", "color", "archivedAt"]) {
        if (input[key] !== undefined) payload[key] = input[key];
      }
      const hasGoalMutation = input.goalIds !== undefined || input.goalId !== undefined;
      const headers: Record<string, string> = {
        "x-rudder-idempotency-key": hasGoalMutation || input.idempotencyKey !== undefined
          ? requiredString(input, "idempotencyKey")
          : randomUUID(),
      };
      if (hasGoalMutation) {
        headers["x-rudder-required-authority"] = "rust";
      }
      const orgId = optionalString(env.RUDDER_ORG_ID);
      const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
      return { data: await api.patch(
        `/api/projects/${encodeURIComponent(project)}${query}`,
        payload,
        Object.keys(headers).length > 0 ? { headers } : undefined,
      ) };
    }
    default:
      return null;
  }
}

export function organizationBrandColorCliArgs(
  input: Record<string, unknown>,
  env: D1RuntimeEnv,
  requiredString: CliHelpers["requiredString"],
  pushOptional: CliHelpers["pushOptional"],
): string[] {
  const args = ["org", "brand-color", "update"];
  pushOptional(args, "--org-id", env.RUDDER_ORG_ID);
  let hasPatch = false;
  if (Object.prototype.hasOwnProperty.call(input, "brandColor") && input.brandColor !== undefined) {
    hasPatch = true;
    if (input.brandColor === null) args.push("--clear-brand-color");
    else pushOptional(args, "--brand-color", normalizedBrandingValue("brandColor", input.brandColor));
  }
  if (Object.prototype.hasOwnProperty.call(input, "logoAssetId") && input.logoAssetId !== undefined) {
    hasPatch = true;
    if (input.logoAssetId === null) args.push("--clear-logo");
    else pushOptional(args, "--logo-asset-id", normalizedBrandingValue("logoAssetId", input.logoAssetId));
  }
  if (!hasPatch) throw new Error("Provide brandColor or logoAssetId to update");
  args.push("--idempotency-key", requiredString(input, "idempotencyKey"));
  return args;
}

export function projectUpdateCliArgs(
  input: Record<string, unknown>,
  helpers: CliHelpers,
): string[] {
  const args = ["project", "update", helpers.requiredAnyString(input, ["project", "projectId"])];
  helpers.pushOptional(args, "--name", input.name);
  helpers.pushOptional(args, "--description", input.description);
  helpers.pushOptional(args, "--status", input.status);
  helpers.pushOptional(args, "--goal-id", input.goalId);
  if (Array.isArray(input.goalIds)) {
    const items = input.goalIds.map((entry) => helpers.optionalString(entry)).filter((entry): entry is string => Boolean(entry));
    args.push("--goal-ids", items.join(","));
  } else {
    helpers.pushOptional(args, "--goal-ids", input.goalIds);
  }
  helpers.pushOptional(args, "--lead-agent-id", input.leadAgentId);
  helpers.pushOptional(args, "--target-date", input.targetDate);
  helpers.pushOptional(args, "--color", input.color);
  helpers.pushOptional(args, "--archived-at", input.archivedAt);
  if (input.goalIds !== undefined || input.goalId !== undefined || input.idempotencyKey !== undefined) {
    args.push("--idempotency-key", helpers.requiredString(input, "idempotencyKey"));
  }
  return args;
}
