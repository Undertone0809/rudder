import { z } from "zod";

const nativeIdentifierSchema = z.string().trim().min(1).max(500);
const nativeReasonSchema = z.string().trim().min(1).max(2_000);
const nativeSensitiveFieldSuffixes = [
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "sessiontoken",
  "token",
  "value",
] as const;

function isNativeSensitiveField(key: string) {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return nativeSensitiveFieldSuffixes.some((suffix) => (
    normalized === suffix
    || normalized.startsWith(suffix)
    || normalized.endsWith(suffix)
    || normalized.endsWith(`${suffix}s`)
  ));
}

const nativeSafeJsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string().max(100_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(nativeSafeJsonValueSchema).max(1_000),
  nativeSafeJsonRecordSchema,
]));

const nativeSafeJsonRecordSchema = z.record(
  z.string().trim().min(1).max(200),
  nativeSafeJsonValueSchema,
).superRefine((value, ctx) => {
  for (const [key, child] of Object.entries(value)) {
    if (isNativeSensitiveField(key) && child !== "[REDACTED]") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: "Sensitive native payload fields must be redacted",
      });
    }
  }
});

const nativeForkSessionSchema = z.object({
  sessionId: nativeIdentifierSchema,
  sessionParams: nativeSafeJsonRecordSchema,
  sessionDisplayId: nativeIdentifierSchema,
}).strict();

const nativeForkResultSchema = z.object({
  session: nativeForkSessionSchema,
  boundary: nativeIdentifierSchema,
  sourceBoundary: nativeIdentifierSchema.nullable().optional(),
  identityMap: z.record(nativeIdentifierSchema, nativeIdentifierSchema).optional(),
  continuity: z.literal("native"),
}).strict();

const nativeSteerResultSchema = z.discriminatedUnion("disposition", [
  z.object({
    disposition: z.literal("accepted_current"),
    providerThreadId: nativeIdentifierSchema,
    providerTurnId: nativeIdentifierSchema,
  }).strict(),
  z.object({
    disposition: z.literal("acceptance_unknown"),
    providerThreadId: nativeIdentifierSchema.nullable().optional(),
    providerTurnId: nativeIdentifierSchema.nullable().optional(),
    reason: nativeReasonSchema,
  }).strict(),
  z.object({
    disposition: z.literal("closing"),
    reason: nativeReasonSchema.nullable().optional(),
  }).strict(),
  z.object({
    disposition: z.literal("unsupported"),
    reason: nativeReasonSchema.nullable().optional(),
  }).strict(),
]);

const nativeInterruptResultSchema = z.enum([
  "acknowledged",
  "waiting_safe_boundary",
  "unverified",
]);

const nativeApprovalRequestSchema = z.object({
  type: z.literal("agent_runtime"),
  payload: z.object({
    provider: z.literal("hermes"),
    runtimeType: z.literal("hermes_gateway"),
    upstreamRunId: nativeIdentifierSchema,
    sessionId: nativeIdentifierSchema,
    event: nativeSafeJsonRecordSchema.refine(
      (event) => event.event === "approval.request",
      "Native approval payload must describe an approval.request event",
    ),
    choices: z.tuple([z.literal("once"), z.literal("deny")]),
  }).strict(),
}).strict();

const nativeApprovalHandleSchema = z.object({
  id: nativeIdentifierSchema,
  status: z.enum(["pending", "approved", "rejected", "cancelled"]),
}).strict();

const nativeApprovalDecisionSchema = z.object({
  id: nativeIdentifierSchema,
  status: z.enum(["pending", "approved", "rejected", "cancelled"]),
  decisionNote: z.string().trim().max(5_000).nullable().optional(),
}).strict();

function parseNativePayload<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  payload: unknown,
  label: string,
): z.infer<TSchema> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "root";
    throw new Error(`Invalid native ${label} payload at ${path}: ${issue?.message ?? "schema mismatch"}`);
  }
  return parsed.data;
}

export type ChatNativeForkResultPayload = z.infer<typeof nativeForkResultSchema>;
export type ChatNativeSteerResultPayload = z.infer<typeof nativeSteerResultSchema>;
export type ChatNativeInterruptResultPayload = z.infer<typeof nativeInterruptResultSchema>;
export type ChatNativeApprovalRequestPayload = z.infer<typeof nativeApprovalRequestSchema>;
export type ChatNativeApprovalHandlePayload = z.infer<typeof nativeApprovalHandleSchema>;
export type ChatNativeApprovalDecisionPayload = z.infer<typeof nativeApprovalDecisionSchema>;

export function validateNativeForkResult(
  payload: unknown,
  expected: { boundary?: string; sourceBoundary?: string | null } = {},
) {
  const result = parseNativePayload(nativeForkResultSchema, payload, "fork result");
  if (expected.boundary !== undefined && result.boundary !== expected.boundary.trim()) {
    throw new Error("Invalid native fork result: provider boundary does not match the requested boundary");
  }
  if (
    expected.sourceBoundary !== undefined
    && result.sourceBoundary !== (expected.sourceBoundary === null ? null : expected.sourceBoundary.trim())
  ) {
    throw new Error("Invalid native fork result: source boundary does not match the selected source span");
  }
  return result;
}

export function validateNativeSteerResult(
  payload: unknown,
  expected: { providerThreadId?: string | null } = {},
) {
  const result = parseNativePayload(nativeSteerResultSchema, payload, "steer result");
  const expectedThreadId = expected.providerThreadId?.trim() || null;
  const actualThreadId = "providerThreadId" in result ? result.providerThreadId : null;
  if (expectedThreadId && actualThreadId && actualThreadId !== expectedThreadId) {
    throw new Error("Invalid native steer result: provider thread does not match the active control handle");
  }
  return result;
}

export function validateNativeInterruptResult(payload: unknown) {
  return parseNativePayload(nativeInterruptResultSchema, payload, "interrupt result");
}

export function validateNativeControlResult(
  kind: "steer" | "interrupt",
  payload: unknown,
  expected: { providerThreadId?: string | null } = {},
) {
  return kind === "steer"
    ? validateNativeSteerResult(payload, expected)
    : validateNativeInterruptResult(payload);
}

export function validateNativeApprovalRequest(payload: unknown) {
  return parseNativePayload(nativeApprovalRequestSchema, payload, "approval request");
}

export function validateNativeApprovalHandle(payload: unknown) {
  return parseNativePayload(nativeApprovalHandleSchema, payload, "approval handle");
}

export function validateNativeApprovalDecision(payload: unknown) {
  return parseNativePayload(nativeApprovalDecisionSchema, payload, "approval decision");
}

export function validateNativeSecretSafePayload(payload: unknown) {
  return parseNativePayload(nativeSafeJsonRecordSchema, payload, "secret-safe");
}
