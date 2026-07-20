import { z } from "zod";

const uuid = z.string().uuid();
const nonBlankId = z.string().trim().min(1).max(240);
const nonBlankPath = z.string().trim().min(1).max(4096);

const browserUrlSchema = z.string().trim().min(1).max(8192).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}, "Browser URL must be an absolute HTTP(S) URL");

export const messengerSavedViewTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("browser"), tabId: nonBlankId, url: browserUrlSchema }).strict(),
  z.object({ kind: z.literal("automation"), automationId: uuid }).strict(),
  z.object({ kind: z.literal("library_document"), documentId: uuid }).strict(),
  z.object({ kind: z.literal("library_entry"), entryId: uuid, path: nonBlankPath }).strict(),
  z.object({ kind: z.literal("library_file"), filePath: nonBlankPath }).strict(),
  z.object({ kind: z.literal("library_directory"), directoryPath: nonBlankPath }).strict(),
]);

const savedViewMetadataShape = {
  title: z.string().trim().min(1).max(240),
  subtitle: z.string().trim().max(1000).optional().nullable(),
  favicon: z.string().trim().max(8192).optional().nullable(),
};

export const createMessengerSavedViewSchema = z.object({
  target: messengerSavedViewTargetSchema,
  ...savedViewMetadataShape,
}).strict();

export const updateMessengerSavedViewSchema = z.object({
  target: messengerSavedViewTargetSchema.optional(),
  title: savedViewMetadataShape.title.optional(),
  subtitle: savedViewMetadataShape.subtitle,
  favicon: savedViewMetadataShape.favicon,
  hidden: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const reorderMessengerSavedViewsSchema = z.object({
  ids: z.array(uuid).max(500),
}).strict().superRefine(({ ids }, ctx) => {
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (seen.has(id)) {
      ctx.addIssue({ code: "custom", message: "Saved View ids must be unique", path: ["ids", index] });
    }
    seen.add(id);
  }
});

export const listMessengerSavedViewsQuerySchema = z.object({
  visibility: z.enum(["visible", "hidden", "all"]).default("visible"),
}).strict();

export type MessengerSavedViewTargetInput = z.infer<typeof messengerSavedViewTargetSchema>;
export type CreateMessengerSavedView = z.infer<typeof createMessengerSavedViewSchema>;
export type UpdateMessengerSavedView = z.infer<typeof updateMessengerSavedViewSchema>;
export type ReorderMessengerSavedViews = z.infer<typeof reorderMessengerSavedViewsSchema>;
export type ListMessengerSavedViewsQuery = z.infer<typeof listMessengerSavedViewsQuerySchema>;

export {
  assignMessengerCustomGroupEntrySchema,
  createMessengerCustomGroupSchema,
  createMessengerCustomGroupWithEntriesSchema,
  reorderMessengerCustomGroupEntriesSchema,
  reorderMessengerCustomGroupsSchema,
  updateMessengerCustomGroupSchema
} from "./chat.js";
