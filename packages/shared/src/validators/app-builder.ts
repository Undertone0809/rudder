import { z } from "zod";

export const APP_BUILDER_SOURCE_ROOT_PATTERN =
  /^apps\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const appBuilderBuildStatusSchema = z.enum([
  "preparing",
  "building",
  "verifying",
  "ready",
  "failed",
]);

export const appBuilderRunKindSchema = z.enum(["build", "verification"]);

export const appBuilderSourceRootSchema = z
  .string()
  .trim()
  .max(68)
  .regex(
    APP_BUILDER_SOURCE_ROOT_PATTERN,
    "sourceRoot must be a workspace-relative path in the form apps/<slug>",
  );

const opaqueLocalIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "must be an opaque identifier");

export const createAppBuilderAppSchema = z.object({
  name: z.string().trim().min(1).max(120),
  projectId: z.string().uuid().nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
  sourceRoot: appBuilderSourceRootSchema,
  scaffoldVersion: z.string().trim().min(1).max(120),
});

export const updateAppBuilderBuildSchema = z
  .object({
    status: appBuilderBuildStatusSchema,
    expectedStatus: appBuilderBuildStatusSchema.optional(),
    runId: z.string().uuid().nullable().optional(),
    runKind: appBuilderRunKindSchema.optional().default("build"),
  })
  .superRefine((value, context) => {
    if (value.status === "verifying" && value.runKind !== "verification") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runKind"],
        message: "verifying status requires a verification run",
      });
    }
  });

export const attachAppBuilderConversationSchema = z.object({
  conversationId: z.string().uuid(),
});

export const appBuilderOpaqueBindingSchema = z.object({
  desktopInstallationId: opaqueLocalIdentifierSchema,
  appPublicId: opaqueLocalIdentifierSchema,
  localBindingId: opaqueLocalIdentifierSchema,
});

export type CreateAppBuilderApp = z.infer<typeof createAppBuilderAppSchema>;
export type UpdateAppBuilderBuild = z.infer<typeof updateAppBuilderBuildSchema>;
export type AttachAppBuilderConversation = z.infer<typeof attachAppBuilderConversationSchema>;
export type AppBuilderRunKind = z.infer<typeof appBuilderRunKindSchema>;
export type BindAppBuilderLocalRuntime = z.infer<typeof appBuilderOpaqueBindingSchema>;
