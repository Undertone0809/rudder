import path from "node:path";
import fs from "node:fs/promises";
import { agents, type Db } from "@rudderhq/db";
import type {
  AgentRole,
  OrganizationWorkspaceFileDetail,
  OrganizationWorkspaceFileEntry,
  OrganizationWorkspaceFileList,
  OrganizationWorkspaceRootSource,
} from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { resolveStoredOrDerivedAgentWorkspaceKey } from "../agent-workspace-key.js";
import { notFound, unprocessable } from "../errors.js";
import { ensureOrganizationWorkspaceLayout, resolveOrganizationWorkspaceRoot } from "../home-paths.js";
import { organizationService } from "./orgs.js";

const MAX_PREVIEW_BYTES = 200_000;
const HIDDEN_WORKSPACE_ENTRY_NAMES = new Set([".DS_Store", ".cache", ".npm", ".nvm"]);
const WORKSPACE_TEXT_CONTENT_TYPES = new Map([
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".txt", "text/plain"],
  [".json", "application/json"],
  [".csv", "text/csv"],
  [".html", "text/html"],
  [".htm", "text/html"],
]);
const WORKSPACE_IMAGE_CONTENT_TYPES = new Map([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);
const WORKSPACE_BINARY_CONTENT_TYPES = new Map([
  [".pdf", "application/pdf"],
]);

type WorkspaceRootResolution = {
  source: OrganizationWorkspaceRootSource;
  rootPath: string;
  repoUrl: null;
};

function toPortableRelativePath(relativePath: string) {
  return relativePath.split(path.sep).join("/");
}

function normalizeRequestedPath(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveWithinRoot(rootPath: string, requestedPath: string) {
  const normalizedPath = normalizeRequestedPath(requestedPath);
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = normalizedPath ? path.resolve(resolvedRoot, normalizedPath) : resolvedRoot;
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw unprocessable("Requested path must stay inside the organization workspace root");
  }
  return {
    resolvedRoot,
    resolvedTarget,
    normalizedPath: toPortableRelativePath(relative === "" ? "" : relative),
  };
}

async function pathExistsAsDirectory(targetPath: string) {
  return await fs.stat(targetPath).then((entry) => entry.isDirectory()).catch(() => false);
}

async function pathExistsAsFile(targetPath: string) {
  return await fs.stat(targetPath).then((entry) => entry.isFile()).catch(() => false);
}

function hasBinaryBytes(buffer: Buffer) {
  for (const byte of buffer) {
    if (byte === 0) return true;
  }
  return false;
}

function shouldHideWorkspaceEntry(entryName: string) {
  return HIDDEN_WORKSPACE_ENTRY_NAMES.has(entryName);
}

function getWorkspaceFileContentType(filePath: string, buffer?: Buffer) {
  const extension = path.extname(filePath).toLowerCase();
  const mapped = WORKSPACE_TEXT_CONTENT_TYPES.get(extension)
    ?? WORKSPACE_IMAGE_CONTENT_TYPES.get(extension)
    ?? WORKSPACE_BINARY_CONTENT_TYPES.get(extension);
  if (mapped) return mapped;
  if (!buffer) return null;
  return hasBinaryBytes(buffer) ? "application/octet-stream" : "text/plain";
}

const WORKSPACE_IMAGE_CONTENT_TYPE_VALUES = new Set(WORKSPACE_IMAGE_CONTENT_TYPES.values());

function isWorkspaceImageContentType(contentType: string | null | undefined) {
  return typeof contentType === "string" && WORKSPACE_IMAGE_CONTENT_TYPE_VALUES.has(contentType.toLowerCase());
}

function getWorkspaceFileContentPath(orgId: string, normalizedPath: string) {
  const search = new URLSearchParams({ path: normalizedPath });
  return `/api/orgs/${orgId}/workspace/file/content?${search.toString()}`;
}

function getWorkspaceFilePreviewKind(contentType: string, buffer: Buffer): OrganizationWorkspaceFileDetail["previewKind"] {
  if (isWorkspaceImageContentType(contentType)) return "image";
  return hasBinaryBytes(buffer) ? "binary" : "text";
}

export function organizationWorkspaceBrowserService(db: Db) {
  const orgs = organizationService(db);

  async function listAgentWorkspaceDirectoryMap(orgId: string) {
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        icon: agents.icon,
        workspaceKey: agents.workspaceKey,
      })
      .from(agents)
      .where(eq(agents.orgId, orgId));

    return new Map(
      rows.map((row) => {
        const workspaceKey = resolveStoredOrDerivedAgentWorkspaceKey(row);
        return [
          workspaceKey,
          {
            id: row.id,
            name: row.name,
            role: row.role as AgentRole,
            icon: row.icon ?? null,
            workspaceKey,
          },
        ];
      }),
    );
  }

  /**
   * Keep immutable workspace directory handles while showing the current Agent
   * identity in `/workspaces`.
   *
   * Reasoning:
   * - Renaming an Agent must not rename its canonical workspace directory.
   * - The browser should still present the latest Agent name instead of the
   *   old `workspaceKey` slug as the primary UI label.
   *
   * Traceability:
   * - doc/plans/2026-04-21-agent-workspace-browser-identity-labels.md
   */
  async function decorateWorkspaceEntries(
    orgId: string,
    directoryPath: string,
    entries: OrganizationWorkspaceFileEntry[],
  ): Promise<OrganizationWorkspaceFileEntry[]> {
    if (directoryPath !== "agents") return entries;

    const agentDirectoriesByWorkspaceKey = await listAgentWorkspaceDirectoryMap(orgId);
    return entries.map((entry) => {
      if (!entry.isDirectory) return entry;
      const agentDirectory = agentDirectoriesByWorkspaceKey.get(entry.name);
      if (!agentDirectory) return entry;
      return {
        ...entry,
        displayLabel: agentDirectory.name,
        entityType: "agent_workspace",
        agentId: agentDirectory.id,
        agentIcon: agentDirectory.icon,
        agentRole: agentDirectory.role,
        workspaceKey: agentDirectory.workspaceKey,
      };
    });
  }

  async function resolveWorkspaceRoot(orgId: string): Promise<WorkspaceRootResolution> {
    const organization = await orgs.getById(orgId);
    if (!organization) throw notFound("Organization not found");

    await ensureOrganizationWorkspaceLayout(orgId);

    return {
      source: "org_root",
      rootPath: resolveOrganizationWorkspaceRoot(orgId),
      repoUrl: null,
    };
  }

  return {
    async listFiles(orgId: string, directoryPath = ""): Promise<OrganizationWorkspaceFileList> {
      const root = await resolveWorkspaceRoot(orgId);
      const { resolvedRoot, resolvedTarget, normalizedPath } = resolveWithinRoot(root.rootPath, directoryPath);
      const rootExists = await pathExistsAsDirectory(resolvedRoot);
      if (!rootExists) {
        return {
          source: root.source,
          rootPath: resolvedRoot,
          repoUrl: root.repoUrl,
          directoryPath: "",
          rootExists: false,
          entries: [],
          message: "The workspace root is not available on this machine yet.",
        };
      }

      if (!(await pathExistsAsDirectory(resolvedTarget))) {
        throw notFound("Directory not found inside the organization workspace");
      }

      const rawEntries = (await fs.readdir(resolvedTarget, { withFileTypes: true }))
        .filter((entry) => !shouldHideWorkspaceEntry(entry.name));
      const unsortedEntries: OrganizationWorkspaceFileEntry[] = rawEntries.map((entry) => {
        const entryPath = toPortableRelativePath(path.relative(resolvedRoot, path.join(resolvedTarget, entry.name)));
        return {
          name: entry.name,
          path: entryPath,
          isDirectory: entry.isDirectory(),
        };
      });
      const decoratedEntries = await decorateWorkspaceEntries(orgId, normalizedPath, unsortedEntries);
      const entries: OrganizationWorkspaceFileEntry[] = decoratedEntries.sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
        return (left.displayLabel ?? left.name).localeCompare(right.displayLabel ?? right.name);
      });

      return {
        source: root.source,
        rootPath: resolvedRoot,
        repoUrl: root.repoUrl,
        directoryPath: normalizedPath,
        rootExists: true,
        entries,
        message: entries.length === 0 ? "This folder is empty." : null,
      };
    },

    async readFile(orgId: string, filePath: string): Promise<OrganizationWorkspaceFileDetail> {
      const root = await resolveWorkspaceRoot(orgId);
      const { resolvedRoot, resolvedTarget, normalizedPath } = resolveWithinRoot(root.rootPath, filePath);
      const rootExists = await pathExistsAsDirectory(resolvedRoot);
      if (!rootExists) {
        return {
          source: root.source,
          rootPath: resolvedRoot,
          repoUrl: root.repoUrl,
          filePath: normalizedPath,
          rootExists: false,
          content: null,
          contentType: null,
          previewKind: "binary",
          contentPath: null,
          message: "The workspace root is not available on this machine yet.",
          truncated: false,
        };
      }

      if (!(await pathExistsAsFile(resolvedTarget))) {
        throw notFound("File not found inside the organization workspace");
      }

      const buffer = await fs.readFile(resolvedTarget);
      const contentType = getWorkspaceFileContentType(normalizedPath || resolvedTarget, buffer) ?? "application/octet-stream";
      const previewKind = getWorkspaceFilePreviewKind(contentType, buffer);
      if (previewKind === "image") {
        return {
          source: root.source,
          rootPath: resolvedRoot,
          repoUrl: root.repoUrl,
          filePath: normalizedPath,
          rootExists: true,
          content: null,
          contentType,
          previewKind,
          contentPath: getWorkspaceFileContentPath(orgId, normalizedPath),
          message: null,
          truncated: false,
        };
      }
      if (previewKind === "binary") {
        return {
          source: root.source,
          rootPath: resolvedRoot,
          repoUrl: root.repoUrl,
          filePath: normalizedPath,
          rootExists: true,
          content: null,
          contentType,
          previewKind,
          contentPath: null,
          message: "Binary files are not previewed in the organization workspace view.",
          truncated: false,
        };
      }

      const truncated = buffer.length > MAX_PREVIEW_BYTES;
      const rawContent = buffer.subarray(0, MAX_PREVIEW_BYTES).toString("utf8");
      return {
        source: root.source,
        rootPath: resolvedRoot,
        repoUrl: root.repoUrl,
        filePath: normalizedPath,
        rootExists: true,
        content: rawContent,
        contentType,
        previewKind,
        contentPath: null,
        message: truncated ? "Preview truncated to the first 200 KB." : null,
        truncated,
      };
    },

    async readAttachmentFile(orgId: string, filePath: string): Promise<{
      normalizedPath: string;
      originalFilename: string;
      contentType: string;
      buffer: Buffer;
    }> {
      const root = await resolveWorkspaceRoot(orgId);
      const { resolvedRoot, resolvedTarget, normalizedPath } = resolveWithinRoot(root.rootPath, filePath);
      const rootExists = await pathExistsAsDirectory(resolvedRoot);
      if (!rootExists) {
        throw notFound("The workspace root is not available on this machine yet.");
      }
      if (!(await pathExistsAsFile(resolvedTarget))) {
        throw notFound("File not found inside the organization workspace");
      }

      const buffer = await fs.readFile(resolvedTarget);
      return {
        normalizedPath,
        originalFilename: path.basename(resolvedTarget),
        contentType: getWorkspaceFileContentType(normalizedPath || resolvedTarget, buffer) ?? "application/octet-stream",
        buffer,
      };
    },

    async writeFile(
      orgId: string,
      filePath: string,
      content: string,
    ): Promise<OrganizationWorkspaceFileDetail> {
      const root = await resolveWorkspaceRoot(orgId);
      const { resolvedRoot, resolvedTarget, normalizedPath } = resolveWithinRoot(root.rootPath, filePath);
      const rootExists = await pathExistsAsDirectory(resolvedRoot);
      if (!rootExists) {
        throw notFound("The workspace root is not available on this machine yet.");
      }
      if (!(await pathExistsAsFile(resolvedTarget))) {
        throw notFound("File not found inside the organization workspace");
      }

      await fs.writeFile(resolvedTarget, content, "utf8");

      return {
        source: root.source,
        rootPath: resolvedRoot,
        repoUrl: root.repoUrl,
        filePath: normalizedPath,
        rootExists: true,
        content,
        contentType: getWorkspaceFileContentType(normalizedPath || resolvedTarget) ?? "text/plain",
        previewKind: "text",
        contentPath: null,
        message: null,
        truncated: false,
      };
    },
  };
}
