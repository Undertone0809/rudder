import { z } from "zod";
import { AGENT_RUNTIME_TYPES } from "../constants.js";

const agentRuntimeTypes = new Set<string>(AGENT_RUNTIME_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateModelFallbacksConfig(
  value: Record<string, unknown>,
  ctx: z.RefinementCtx,
  pathPrefix: Array<string | number>,
) {
  const fallbackModels = value.modelFallbacks;
  if (fallbackModels === undefined) return;

  if (!Array.isArray(fallbackModels)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "modelFallbacks must be an array",
      path: [...pathPrefix, "modelFallbacks"],
    });
    return;
  }

  fallbackModels.forEach((fallback, index) => {
    if (typeof fallback === "string") {
      if (fallback.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "modelFallbacks string entries must be non-empty",
          path: [...pathPrefix, "modelFallbacks", index],
        });
      }
      return;
    }

    if (!isRecord(fallback)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "modelFallbacks entries must be strings or runtime/model objects",
        path: [...pathPrefix, "modelFallbacks", index],
      });
      return;
    }

    if (typeof fallback.agentRuntimeType !== "string" || fallback.agentRuntimeType.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "modelFallbacks entries must include agentRuntimeType",
        path: [...pathPrefix, "modelFallbacks", index, "agentRuntimeType"],
      });
    } else if (!agentRuntimeTypes.has(fallback.agentRuntimeType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "modelFallbacks entries must include a valid agentRuntimeType",
        path: [...pathPrefix, "modelFallbacks", index, "agentRuntimeType"],
      });
    }
    if (typeof fallback.model !== "string" || fallback.model.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "modelFallbacks entries must include model",
        path: [...pathPrefix, "modelFallbacks", index, "model"],
      });
    }
    if (fallback.config !== undefined && !isRecord(fallback.config)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "modelFallbacks entry config must be an object",
        path: [...pathPrefix, "modelFallbacks", index, "config"],
      });
    }
  });
}
