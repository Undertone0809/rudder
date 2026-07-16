import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { chatsApi } from "./chats";
import { api } from "./client";
import { issuesApi } from "./issues";

vi.mock("./client", () => ({
  api: {
    get: vi.fn(),
  },
}));

const getMock = vi.mocked(api.get);

describe("list API query parameters", () => {
  beforeEach(() => {
    getMock.mockReset();
    getMock.mockResolvedValue([]);
  });

  it("passes chat search limits through to the API", async () => {
    await chatsApi.list("org-1", "all", { q: "skill", limit: 20 });

    expect(getMock).toHaveBeenCalledWith("/orgs/org-1/chats?status=all&q=skill&limit=20");
  });

  it("passes server-side chat project filters through to the API", async () => {
    await chatsApi.list("org-1", "active", { projectId: "project-1", limit: 40 });

    expect(getMock).toHaveBeenCalledWith(
      "/orgs/org-1/chats?status=active&projectId=project-1&limit=40",
    );
  });

  it("keeps project chat previews isolated from the organization preview cache", () => {
    const organizationPreview = queryKeys.chats.listPreview("org-1", "active", 40);
    const projectPreview = queryKeys.chats.listPreview("org-1", "active", 40, "__none__");

    expect(projectPreview).not.toEqual(organizationPreview);
  });

  it("passes issue search limits through to the API", async () => {
    await issuesApi.list("org-1", {
      q: "skill",
      searchFields: ["title", "description", "comment"],
      limit: 20,
      offset: 40,
    });

    expect(getMock).toHaveBeenCalledWith(
      "/orgs/org-1/issues?q=skill&searchFields=title%2Cdescription%2Ccomment&limit=20&offset=40",
    );
  });

  it("passes server-side issue scope filters through to the API", async () => {
    await issuesApi.list("org-1", {
      followedByUserId: "me",
      involvedUserId: "user-1",
      limit: 25,
    });

    expect(getMock).toHaveBeenCalledWith(
      "/orgs/org-1/issues?followedByUserId=me&involvedUserId=user-1&limit=25",
    );
  });
});
