import { describe, expect, it } from "vitest";
import {
  assignMessengerCustomGroupEntrySchema,
  createMessengerCustomGroupWithEntriesSchema,
  createMessengerSavedViewSchema,
  keepMessengerSavedViewSchema,
  listMessengerSavedViewsQuerySchema,
  messengerSavedViewIdSchema,
  reorderMessengerCustomGroupEntriesSchema,
  reorderMessengerSavedViewsSchema,
  updateMessengerSavedViewSchema,
} from "./messenger.js";

const automationId = "11111111-1111-4111-8111-111111111111";
const savedViewId = "22222222-2222-4222-8222-222222222222";
const savedViewItemKey = `saved-view:${savedViewId}`;
const viewInstanceId = "view-instance-1";

describe("Messenger Saved View validators", () => {
  it("accepts every supported target identity", () => {
    const targets = [
      { kind: "browser", tabId: "tab-1", url: "https://rudder.example/path", viewInstanceId },
      { kind: "automation", automationId, viewInstanceId },
      { kind: "library_document", documentId: automationId, viewInstanceId },
      { kind: "library_entry", entryId: automationId, path: "plans/launch.md", viewInstanceId },
      { kind: "library_file", filePath: "workspace/README.md", viewInstanceId },
      { kind: "library_directory", directoryPath: "workspace/docs", viewInstanceId },
      {
        kind: "local_app",
        desktopInstallationId: "desktop-1",
        appPublicId: "com.example.rudder-helper",
        localBindingId: "binding-1",
        viewInstanceId,
      },
    ];

    for (const target of targets) {
      expect(createMessengerSavedViewSchema.safeParse({ target, title: "Saved target" }).success).toBe(true);
    }
  });

  it("rejects blank and unsupported Browser URLs plus malformed resource identities", () => {
    for (const url of ["", "about:blank", "javascript:alert(1)", "file:///tmp/private"]) {
      expect(createMessengerSavedViewSchema.safeParse({
        target: { kind: "browser", tabId: "tab-1", url, viewInstanceId },
        title: "Browser",
      }).success).toBe(false);
    }

    expect(createMessengerSavedViewSchema.safeParse({
      target: { kind: "automation", automationId: "not-a-uuid", viewInstanceId },
      title: "Automation",
    }).success).toBe(false);
    expect(createMessengerSavedViewSchema.safeParse({
      target: { kind: "library_file", filePath: "   ", viewInstanceId },
      title: "File",
    }).success).toBe(false);
  });

  it("accepts only canonical portable Library paths, including the Library root", () => {
    expect(createMessengerSavedViewSchema.safeParse({
      target: { kind: "library_directory", directoryPath: "", viewInstanceId },
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
        target: { kind: "library_file", filePath: invalidPath, viewInstanceId },
        title: "Invalid path",
      }).success).toBe(false);
    }
  });

  it("requires a nonblank view instance and keeps local app identity opaque", () => {
    expect(createMessengerSavedViewSchema.safeParse({
      target: { kind: "library_file", filePath: "README.md" },
      title: "Missing instance",
    }).success).toBe(false);
    expect(createMessengerSavedViewSchema.safeParse({
      target: {
        kind: "local_app",
        desktopInstallationId: "desktop-1",
        appPublicId: "app-1",
        localBindingId: "binding-1",
        viewInstanceId: "   ",
      },
      title: "Blank instance",
    }).success).toBe(false);

    for (const forbidden of ["url", "route", "port", "cwd", "command", "env", "pid"] as const) {
      expect(createMessengerSavedViewSchema.safeParse({
        target: {
          kind: "local_app",
          desktopInstallationId: "desktop-1",
          appPublicId: "app-1",
          localBindingId: "binding-1",
          viewInstanceId,
          [forbidden]: forbidden === "port" || forbidden === "pid" ? 3100 : "secret",
        },
        title: "Unsafe app",
      }).success).toBe(false);
    }
  });

  it("validates strict Keep metadata and anchor or explicit group placement", () => {
    const base = {
      target: { kind: "library_file" as const, filePath: "README.md", viewInstanceId },
      title: "README",
      clientMutationId: "33333333-3333-4333-8333-333333333333",
    };
    expect(keepMessengerSavedViewSchema.safeParse({
      ...base,
      placement: { kind: "anchor", anchor: { kind: "chat", conversationId: automationId } },
    }).success).toBe(true);
    expect(keepMessengerSavedViewSchema.safeParse({
      ...base,
      placement: { kind: "anchor", anchor: { kind: "issue", issueId: automationId } },
    }).success).toBe(true);
    expect(keepMessengerSavedViewSchema.safeParse({
      ...base,
      placement: { kind: "group", groupId: automationId },
    }).success).toBe(true);
    expect(keepMessengerSavedViewSchema.safeParse({
      ...base,
      placement: { kind: "group", groupId: automationId, extra: true },
    }).success).toBe(false);
    expect(keepMessengerSavedViewSchema.safeParse({
      ...base,
      clientMutationId: "not-a-uuid",
      placement: { kind: "group", groupId: automationId },
    }).success).toBe(false);
  });

  it("validates metadata updates, legacy restoration, and complete reorder identities", () => {
    expect(updateMessengerSavedViewSchema.safeParse({ title: "Renamed" }).success).toBe(true);
    expect(updateMessengerSavedViewSchema.safeParse({ primaryRailPinned: true }).success).toBe(true);
    expect(updateMessengerSavedViewSchema.safeParse({ hidden: false }).success).toBe(true);
    expect(updateMessengerSavedViewSchema.safeParse({ hidden: true }).success).toBe(false);
    expect(updateMessengerSavedViewSchema.safeParse({}).success).toBe(false);
    expect(listMessengerSavedViewsQuerySchema.parse({})).toEqual({ visibility: "visible", limit: 50, offset: 0 });
    expect(listMessengerSavedViewsQuerySchema.parse({ visibility: "hidden", limit: "100", offset: "50" })).toEqual({
      visibility: "hidden",
      limit: 100,
      offset: 50,
    });
    expect(listMessengerSavedViewsQuerySchema.parse({ primaryRailPinned: "true" }).primaryRailPinned).toBe(true);
    expect(listMessengerSavedViewsQuerySchema.safeParse({ primaryRailPinned: "false" }).success).toBe(false);
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
    expect(createMessengerCustomGroupWithEntriesSchema.parse({
      name: "Mixed",
      itemKeys: ["chat:abc", savedViewItemKey],
      anchorItemKey: "chat:abc",
    })).toMatchObject({
      itemKeys: ["chat:abc", savedViewItemKey],
      anchorItemKey: "chat:abc",
    });
    expect(createMessengerCustomGroupWithEntriesSchema.safeParse({
      name: "Mixed",
      itemKeys: ["chat:abc", savedViewItemKey],
      anchorItemKey: "chat:missing",
    }).success).toBe(false);
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
