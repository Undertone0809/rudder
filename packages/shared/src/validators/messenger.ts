import { z } from "zod";

const uuid = z.string().uuid();
export const messengerSavedViewIdSchema = uuid;
const nonBlankId = z.string().trim().min(1).max(240);
const viewInstanceIdSchema = z.string().trim().min(1).max(1000);

function isCanonicalPortableLibraryPath(value: string, allowRoot: boolean) {
  if (allowRoot && value === "") return true;
  if (!value || value !== value.trim()) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => Boolean(segment)
    && segment !== "."
    && segment !== ".."
    && !segment.startsWith("~"));
}

const libraryPathSchema = z.string().max(4096)
  .refine((value) => isCanonicalPortableLibraryPath(value, false), "Library path must be canonical and relative");
const libraryDirectoryPathSchema = z.string().max(4096)
  .refine((value) => isCanonicalPortableLibraryPath(value, true), "Library directory path must be canonical and relative");

const browserUrlSchema = z.string().trim().min(1).max(8192).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}, "Browser URL must be an absolute HTTP(S) URL");

export const messengerSavedViewTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("browser"), tabId: nonBlankId, url: browserUrlSchema, viewInstanceId: viewInstanceIdSchema }).strict(),
  z.object({ kind: z.literal("automation"), automationId: uuid, viewInstanceId: viewInstanceIdSchema }).strict(),
  z.object({ kind: z.literal("library_document"), documentId: uuid, viewInstanceId: viewInstanceIdSchema }).strict(),
  z.object({ kind: z.literal("library_entry"), entryId: uuid, path: libraryPathSchema, viewInstanceId: viewInstanceIdSchema }).strict(),
  z.object({ kind: z.literal("library_file"), filePath: libraryPathSchema, viewInstanceId: viewInstanceIdSchema }).strict(),
  z.object({ kind: z.literal("library_directory"), directoryPath: libraryDirectoryPathSchema, viewInstanceId: viewInstanceIdSchema }).strict(),
  z.object({
    kind: z.literal("local_app"),
    desktopInstallationId: nonBlankId,
    appPublicId: nonBlankId,
    localBindingId: nonBlankId,
    viewInstanceId: viewInstanceIdSchema,
  }).strict(),
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

const messengerSavedViewAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat"), conversationId: uuid }).strict(),
  z.object({ kind: z.literal("issue"), issueId: uuid }).strict(),
]);

export const keepMessengerSavedViewSchema = z.object({
  target: messengerSavedViewTargetSchema,
  ...savedViewMetadataShape,
  clientMutationId: uuid,
  placement: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("anchor"), anchor: messengerSavedViewAnchorSchema }).strict(),
    z.object({ kind: z.literal("group"), groupId: uuid }).strict(),
  ]),
}).strict();

export const updateMessengerSavedViewSchema = z.object({
  target: messengerSavedViewTargetSchema.optional(),
  title: savedViewMetadataShape.title.optional(),
  subtitle: savedViewMetadataShape.subtitle,
  favicon: savedViewMetadataShape.favicon,
  primaryRailPinned: z.boolean().optional(),
  // Compatibility-only escape hatch for legacy hidden rows. The current
  // group-only Saved View model has no operation that creates hidden rows.
  hidden: z.literal(false).optional(),
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
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  primaryRailPinned: z.union([z.literal("true"), z.literal(true)]).transform(() => true).optional(),
}).strict();

export type MessengerSavedViewTargetInput = z.infer<typeof messengerSavedViewTargetSchema>;
export type CreateMessengerSavedView = z.infer<typeof createMessengerSavedViewSchema>;
export type KeepMessengerSavedView = z.infer<typeof keepMessengerSavedViewSchema>;
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
