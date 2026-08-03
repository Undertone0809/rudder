import { z } from "zod";

export const aiSearchRequestSchema = z.object({
  query: z.string().trim().min(2).max(240),
});

export type AiSearchRequest = z.infer<typeof aiSearchRequestSchema>;
