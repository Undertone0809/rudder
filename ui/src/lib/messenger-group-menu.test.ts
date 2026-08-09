import type { MessengerCustomGroupWithEntries } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import {
  getMessengerGroupMenuOptions,
  latestMessengerGroupActivityAt,
  MESSENGER_GROUP_MENU_THRESHOLD,
} from "./messenger-group-menu";

type TestGroup = Pick<MessengerCustomGroupWithEntries, "id" | "updatedAt" | "entries">;

const NOW = new Date("2026-08-05T12:00:00.000Z");

function group(
  id: string,
  updatedAt: string,
  entries: Array<Record<string, unknown>> = [],
): TestGroup {
  return { id, updatedAt: new Date(updatedAt), entries } as unknown as TestGroup;
}

function threadEntry(latestActivityAt: string, updatedAt = "2026-07-01T00:00:00.000Z") {
  return {
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date(updatedAt),
    thread: { latestActivityAt: new Date(latestActivityAt) },
  };
}

describe("messenger group menu", () => {
  it("keeps the persisted order when the group count is within the threshold", () => {
    const groups = Array.from({ length: MESSENGER_GROUP_MENU_THRESHOLD }, (_, index) =>
      group(`group-${index}`, "2026-01-01T00:00:00.000Z"));

    expect(getMessengerGroupMenuOptions(groups, NOW)).toEqual(groups);
  });

  it("filters large group lists to the recent window and sorts by latest activity", () => {
    const groups = [
      group("manual-order", "2026-01-01T00:00:00.000Z"),
      group("thread-active", "2026-01-01T00:00:00.000Z", [
        threadEntry("2026-08-04T10:00:00.000Z"),
      ]),
      group("saved-view-active", "2026-08-04T10:00:00.000Z", [{
        createdAt: new Date("2026-08-04T10:00:00.000Z"),
        updatedAt: new Date("2026-08-04T10:00:00.000Z"),
      }]),
      group("group-updated", "2026-08-05T11:00:00.000Z"),
      group("cutoff", "2026-07-29T12:00:00.000Z"),
      group("too-old", "2026-07-29T11:59:59.000Z"),
      ...Array.from({ length: MESSENGER_GROUP_MENU_THRESHOLD }, (_, index) =>
        group(`old-filler-${index}`, "2026-01-01T00:00:00.000Z")),
    ];

    const options = getMessengerGroupMenuOptions(groups, NOW);

    expect(options.map((candidate) => candidate.id)).toEqual([
      "group-updated",
      "thread-active",
      "saved-view-active",
      "cutoff",
    ]);
  });

  it("uses thread activity without inventing it for Saved View-only groups", () => {
    const threadActive = group("thread-active", "2026-01-01T00:00:00.000Z", [
      threadEntry("2026-08-03T09:00:00.000Z"),
    ]);
    const savedViewOnly = group("saved-view-only", "2026-01-01T00:00:00.000Z", [{
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }]);

    expect(latestMessengerGroupActivityAt(threadActive)).toBe(new Date("2026-08-03T09:00:00.000Z").getTime());
    expect(getMessengerGroupMenuOptions([
      ...Array.from({ length: MESSENGER_GROUP_MENU_THRESHOLD }, (_, index) =>
        group(`filler-${index}`, "2026-01-01T00:00:00.000Z")),
      threadActive,
      savedViewOnly,
    ], NOW).map((candidate) => candidate.id)).toEqual(["thread-active"]);
  });

  it("keeps the persisted order when recent groups have equal activity", () => {
    const groups = [
      group("first", "2026-08-04T12:00:00.000Z"),
      group("second", "2026-08-04T12:00:00.000Z"),
      ...Array.from({ length: MESSENGER_GROUP_MENU_THRESHOLD }, (_, index) =>
        group(`old-${index}`, "2026-01-01T00:00:00.000Z")),
    ];

    expect(getMessengerGroupMenuOptions(groups, NOW).map((candidate) => candidate.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("returns an empty menu when a large collection has no recent activity", () => {
    const groups = Array.from({ length: MESSENGER_GROUP_MENU_THRESHOLD + 1 }, (_, index) =>
      group(`old-${index}`, "2026-01-01T00:00:00.000Z"));

    expect(getMessengerGroupMenuOptions(groups, NOW)).toEqual([]);
  });
});
