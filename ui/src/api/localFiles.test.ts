import type {
  OrganizationSkillListItem,
  OrganizationWorkspaceFileDetail,
} from "@rudderhq/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readAuthorizedLocalFilePreview } from "./localFiles";
import { organizationsApi } from "./orgs";
import { organizationSkillsApi } from "./organizationSkills";

vi.mock("./orgs", () => ({
  organizationsApi: {
    readWorkspaceFile: vi.fn(),
  },
}));

vi.mock("./organizationSkills", () => ({
  organizationSkillsApi: {
    list: vi.fn(),
    file: vi.fn(),
  },
}));

function skill(overrides: Partial<OrganizationSkillListItem> = {}): OrganizationSkillListItem {
  return {
    id: "skill-1",
    orgId: "org-1",
    key: "review-helper",
    slug: "review-helper",
    name: "Review helper",
    description: null,
    sourceType: "local_path",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "references/guide.md", kind: "reference" }],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    attachedAgentCount: 0,
    editable: true,
    editableReason: null,
    sourceLabel: null,
    sourceBadge: "local",
    sourcePath: "/tmp/org-skills/review-helper",
    workspaceEditPath: null,
    ...overrides,
  };
}

describe("readAuthorizedLocalFilePreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(organizationSkillsApi.list).mockResolvedValue([]);
  });

  it("reads registered organization skill files through the inventory-checked skill API", async () => {
    vi.mocked(organizationSkillsApi.list).mockResolvedValue([skill()]);
    vi.mocked(organizationSkillsApi.file).mockResolvedValue({
      skillId: "skill-1",
      path: "references/guide.md",
      kind: "reference",
      content: "# Registered",
      language: "markdown",
      markdown: true,
      editable: true,
    });

    const result = await readAuthorizedLocalFilePreview(
      "org-1",
      "/tmp/org-skills/review-helper/references/guide.md",
    );

    expect(organizationSkillsApi.file).toHaveBeenCalledWith(
      "org-1",
      "skill-1",
      "references/guide.md",
    );
    expect(organizationsApi.readWorkspaceFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      filePath: "references/guide.md",
      content: "# Registered",
      contentType: "text/markdown",
      previewKind: "text",
    });
  });

  it("routes ordinary absolute files through the organization workspace API", async () => {
    const file = {
      source: "org_root",
      rootPath: "/tmp/org-workspace",
      repoUrl: null,
      filePath: "projects/report.md",
      libraryEntryId: null,
      mentionHref: null,
      markdownLink: null,
      rootExists: true,
      content: "# Workspace",
      contentType: "text/markdown",
      previewKind: "text",
      contentPath: null,
      message: null,
      truncated: false,
    } satisfies OrganizationWorkspaceFileDetail;
    vi.mocked(organizationsApi.readWorkspaceFile).mockResolvedValue(file);

    await expect(readAuthorizedLocalFilePreview("org-1", "/tmp/org-workspace/projects/report.md"))
      .resolves.toBe(file);

    expect(organizationsApi.readWorkspaceFile).toHaveBeenCalledWith(
      "org-1",
      "/tmp/org-workspace/projects/report.md",
    );
    expect(organizationSkillsApi.file).not.toHaveBeenCalled();
  });

  it("does not read an unindexed file under a registered skill root", async () => {
    vi.mocked(organizationSkillsApi.list).mockResolvedValue([skill()]);

    await expect(readAuthorizedLocalFilePreview(
      "org-1",
      "/tmp/org-skills/review-helper/secrets.txt",
    )).rejects.toThrow("not part of the selected organization's skill inventory");

    expect(organizationSkillsApi.file).not.toHaveBeenCalled();
    expect(organizationsApi.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("does not send relative paths to a local-file reader", async () => {
    await expect(readAuthorizedLocalFilePreview("org-1", "../private.txt"))
      .rejects.toThrow("not available through the selected organization");

    expect(organizationSkillsApi.list).not.toHaveBeenCalled();
    expect(organizationsApi.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("rejects registered binary skill assets instead of decoding them as text", async () => {
    vi.mocked(organizationSkillsApi.list).mockResolvedValue([skill({
      fileInventory: [{ path: "images/logo.png", kind: "asset" }],
    })]);

    await expect(readAuthorizedLocalFilePreview(
      "org-1",
      "/tmp/org-skills/review-helper/images/logo.png",
    )).rejects.toThrow("does not support an inline text preview");

    expect(organizationSkillsApi.file).not.toHaveBeenCalled();
    expect(organizationsApi.readWorkspaceFile).not.toHaveBeenCalled();
  });
});
