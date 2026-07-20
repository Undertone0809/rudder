import { describe, expect, it } from "vitest";
import {
  assignMessengerCustomGroupEntrySchema,
  createMessengerCustomGroupWithEntriesSchema,
  createMessengerSavedViewSchema,
  listMessengerSavedViewsQuerySchema,
  reorderMessengerCustomGroupEntriesSchema,
  reorderMessengerSavedViewsSchema,
  updateMessengerSavedViewSchema,
} from "./messenger.js";

const automationId = "11111111-1111-4111-8111-111111111111";
const savedViewId = "22222222-2222-4222-8222-222222222222";

describe("Messenger Saved View validators", () => {
  it("accepts every supported target identity", () => {
    const targets = [
      { kind: "browser", tabId: "tab-1", url: "https://rudder.example/path" },
      { kind: "automation", automationId },
      { kind: "library_document", documentId: automationId },
      { kind: "library_entry", entryId: automationId, path: "plans/launch.md" },
      { kind: "library_file", filePath: "/workspace/README.md" },
      { kind: "library_directory", directoryPath: "/workspace/docs" },
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

  it("validates metadata updates, visibility, and complete reorder identities", () => {
    expect(updateMessengerSavedViewSchema.safeParse({ title: "Renamed", hidden: true }).success).toBe(true);
    expect(updateMessengerSavedViewSchema.safeParse({}).success).toBe(false);
    expect(listMessengerSavedViewsQuerySchema.parse({})).toEqual({ visibility: "visible" });
    expect(listMessengerSavedViewsQuerySchema.parse({ visibility: "hidden" })).toEqual({ visibility: "hidden" });
    expect(reorderMessengerSavedViewsSchema.safeParse({ ids: [savedViewId] }).success).toBe(true);
    expect(reorderMessengerSavedViewsSchema.safeParse({ ids: [savedViewId, savedViewId] }).success).toBe(false);
  });
});

describe("Messenger custom group item-key aliases", () => {
  it("accepts canonical and legacy inputs and normalizes them to item fields", () => {
    expect(assignMessengerCustomGroupEntrySchema.parse({ itemKey: "saved-view:abc" })).toEqual({
      itemKey: "saved-view:abc",
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
      itemKeys: ["chat:abc", "saved-view:abc"],
    })).toMatchObject({ itemKeys: ["chat:abc", "saved-view:abc"] });
  });

  it("rejects disagreeing canonical and legacy aliases", () => {
    expect(assignMessengerCustomGroupEntrySchema.safeParse({
      itemKey: "saved-view:abc",
      threadKey: "chat:abc",
    }).success).toBe(false);
    expect(reorderMessengerCustomGroupEntriesSchema.safeParse({
      itemKeys: ["saved-view:abc"],
      threadKeys: ["chat:abc"],
    }).success).toBe(false);
  });
});
