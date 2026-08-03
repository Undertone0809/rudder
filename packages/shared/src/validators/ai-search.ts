import { z } from "zod";

export const aiSearchScopeSchema = z.enum([
  "issue",
  "chat",
  "project",
  "agent",
  "skill",
  "library",
]);

export const aiSearchRequestSchema = z.object({
  query: z.string().trim().min(2).max(240),
  scope: aiSearchScopeSchema.optional(),
});

export type AiSearchRequest = z.infer<typeof aiSearchRequestSchema>;
