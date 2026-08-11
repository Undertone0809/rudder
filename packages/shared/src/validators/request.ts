import { z } from "zod";
import { ASSISTANCE_REQUEST_RESOLUTIONS, REQUEST_STATUSES } from "../constants.js";

export const listRequestsQuerySchema = z.object({
  status: z.enum(REQUEST_STATUSES).optional(),
  kind: z.enum(["approval", "assistance"]).optional(),
});

export const resolveAssistanceRequestSchema = z.object({
  resolution: z.enum(ASSISTANCE_REQUEST_RESOLUTIONS),
  response: z.string().trim().min(1).max(20_000),
});

export const cancelAssistanceRequestSchema = z.object({
  reason: z.string().trim().min(1).max(2_000).optional(),
});

export type ListRequestsQuery = z.infer<typeof listRequestsQuerySchema>;
export type ResolveAssistanceRequest = z.infer<typeof resolveAssistanceRequestSchema>;
export type CancelAssistanceRequest = z.infer<typeof cancelAssistanceRequestSchema>;
