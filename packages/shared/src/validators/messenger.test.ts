import { describe, expect, it } from "vitest";
import {
  assignMessengerCustomGroupEntrySchema,
  createMessengerCustomGroupWithEntriesSchema,
  createMessengerSavedViewSchema,
  listMessengerSavedViewsQuerySchema,
  messengerSavedViewIdSchema,
  reorderMessengerCustomGroupEntriesSchema,
  reorderMessengerSavedViewsSchema,
  updateMessengerSavedViewSchema,
} from "./messenger.js";

const automationId = "11111111-1111-4111-8111-111111111111";
const savedViewId = "22222222-2222-4222-8222-222222222222";
const savedViewItemKey = `saved-view:${savedViewId}`;

describe("Messenger Saved View validators", () => {
  it("accepts every supported target identity", () => {
    const targets = [
      { kind: "browser", tabId: "tab-1", url: "https://rudder.example/path" },
      { kind: "automation", automationId },
      { kind: "library_document", documentId: automationId },
      { kind: "library_entry", entryId: automationId, path: "plans/launch.md" },
      { kind: "library_file", filePath: "workspace/README.md" },
      { kind: "library_directory", directoryPath: "workspace/docs" },
    ];

    for (const target of targets) {
      expect(createMessengerSavedViewSchema.safeParse({ target, title: "Saved target" }).success).toBe(true);
    }
  });

  it("rejects blank and unsupported Browser URLs plus malformed resource identities", () => {
    for (const url of ["", "about:blank", "javascript:alert(1)", "file:///tmp/private"]) {
      expect(createMessengerSavedViewSchema.safeParse({
        target: { kind: "browser", tabId: "tab-1", url },
        title: "Browser",
      }).success).toBe(false);
    }

    expect(createMessengerSavedViewSchema.safeParse({
      target: { kind: "automation", automationId: "not-a-uuid" },
      title: "Automation",
    }).success).toBe(false);
    expect(createMessengerSavedViewSchema.safeParse({
      target: { kind: "library_file", filePath: "   " },
      title: "File",
    }).success).toBe(false);
  });

  it("accepts only canonical portable Library paths, including the Library root", () => {
    expect(createMessengerSavedViewSchema.safeParse({
      target: { kind: "library_directory", directoryPath: "" },
      title: "Library root",
    }).success).toBe(true);

    for (const invalidPath of [
      "/absolute/path",
      "folder\\file.md",
      "~/private",
      "file:secret.md",
      ".",
      "..",
      "folder/./file.md",
      "folder/../file.md",
      "folder//file.md",
      "folder/",
    ]) {
      expect(createMessengerSavedViewSchema.safeParse({
        target: { kind: "library_file", filePath: invalidPath },
        title: "Invalid path",
      }).success).toBe(false);
    }
  });

  it("validates metadata updates, visibility, and complete reorder identities", () => {
    expect(updateMessengerSavedViewSchema.safeParse({ title: "Renamed", hidden: true }).success).toBe(true);
    expect(updateMessengerSavedViewSchema.safeParse({}).success).toBe(false);
    expect(listMessengerSavedViewsQuerySchema.parse({})).toEqual({ visibility: "visible", limit: 50, offset: 0 });
    expect(listMessengerSavedViewsQuerySchema.parse({ visibility: "hidden", limit: "100", offset: "50" })).toEqual({
      visibility: "hidden",
      limit: 100,
      offset: 50,
    });
    expect(listMessengerSavedViewsQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(messengerSavedViewIdSchema.safeParse(savedViewId).success).toBe(true);
    expect(messengerSavedViewIdSchema.safeParse("not-a-uuid").success).toBe(false);
    expect(reorderMessengerSavedViewsSchema.safeParse({ ids: [savedViewId] }).success).toBe(true);
    expect(reorderMessengerSavedViewsSchema.safeParse({ ids: [savedViewId, savedViewId] }).success).toBe(false);
  });
});

describe("Messenger custom group item-key aliases", () => {
  it("accepts canonical and legacy inputs and normalizes them to item fields", () => {
    expect(assignMessengerCustomGroupEntrySchema.parse({ itemKey: savedViewItemKey })).toEqual({
      itemKey: savedViewItemKey,
    });
    expect(assignMessengerCustomGroupEntrySchema.parse({ threadKey: "chat:abc" })).toEqual({
      itemKey: "chat:abc",
      threadKey: "chat:abc",
    });
    expect(reorderMessengerCustomGroupEntriesSchema.parse({ threadKeys: ["chat:abc"] })).toEqual({
      itemKeys: ["chat:abc"],
      threadKeys: ["chat:abc"],
    });
    expect(createMessengerCustomGroupWithEntriesSchema.parse({
      name: "Mixed",
      itemKeys: ["chat:abc", savedViewItemKey],
    })).toMatchObject({ itemKeys: ["chat:abc", savedViewItemKey] });
    expect(assignMessengerCustomGroupEntrySchema.safeParse({ itemKey: "saved-view:not-a-uuid" }).success).toBe(false);
  });

  it("rejects disagreeing canonical and legacy aliases", () => {
    expect(assignMessengerCustomGroupEntrySchema.safeParse({
      itemKey: savedViewItemKey,
      threadKey: "chat:abc",
    }).success).toBe(false);
    expect(reorderMessengerCustomGroupEntriesSchema.safeParse({
      itemKeys: [savedViewItemKey],
      threadKeys: ["chat:abc"],
    }).success).toBe(false);
  });

  it("rejects duplicate reorder keys for canonical, legacy, and matching alias inputs", () => {
    expect(reorderMessengerCustomGroupEntriesSchema.safeParse({
      itemKeys: ["chat:abc", "chat:abc"],
    }).success).toBe(false);
    expect(reorderMessengerCustomGroupEntriesSchema.safeParse({
      threadKeys: [savedViewItemKey, savedViewItemKey],
    }).success).toBe(false);
    expect(reorderMessengerCustomGroupEntriesSchema.safeParse({
      itemKeys: ["chat:abc", "chat:abc"],
      threadKeys: ["chat:abc", "chat:abc"],
    }).success).toBe(false);
  });
});
