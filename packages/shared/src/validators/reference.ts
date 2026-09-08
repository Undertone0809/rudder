import { z } from "zod";
import { parseShortRef, type ShortRefKind } from "../short-refs.js";

const REFERENCE_KIND_LABELS: Record<ShortRefKind, string> = {
  agent: "agent",
  chat: "chat",
  issue_comment: "Issue comment",
  run: "Run",
  message: "message",
  project: "project",
  goal: "Goal",
  user: "user",
  issue: "Issue",
};

const uuidSchema = z.string().uuid();

/**
 * Accept the durable UUID form and the typed short reference for one entity
 * kind. Resolution remains organization-scoped and belongs to the server.
 */
export function organizationEntityReferenceSchema(kind: ShortRefKind, label?: string) {
  const kindLabel = REFERENCE_KIND_LABELS[kind];
  return z.string().superRefine((value, ctx) => {
    if (uuidSchema.safeParse(value).success || parseShortRef(value)?.kind === kind) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${label ?? kindLabel} must be a UUID or typed ${kindLabel.toLowerCase()} short reference`,
    });
  });
}
