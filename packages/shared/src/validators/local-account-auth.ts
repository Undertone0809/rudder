import { z } from "zod";

export const localServerExchangeSchema = z.object({
  exchangeCode: z.string().min(16).max(16_384),
}).strict();

export type LocalServerExchangeInput = z.infer<typeof localServerExchangeSchema>;

export const localOfflineGrantSchema = z.object({
  grant: z.string().min(32).max(32_768),
  devicePublicKeySpki: z.string().min(32).max(4_096),
  proof: z.object({
    payload: z.object({
      version: z.literal(1),
      grantHash: z.string().min(16).max(128),
      method: z.string().min(1).max(16),
      path: z.string().min(1).max(2_048),
      bodyHash: z.string().min(1).max(128),
      nonce: z.string().min(16).max(256),
      issuedAtMs: z.number().int().safe(),
    }).strict(),
    signature: z.string().min(16).max(1_024),
  }).strict(),
}).strict();

export type LocalOfflineGrantInput = z.infer<typeof localOfflineGrantSchema>;
