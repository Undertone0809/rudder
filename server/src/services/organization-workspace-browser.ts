import path from "node:path";
import fs from "node:fs/promises";
import { agents, type Db } from "@rudderhq/db";
import type {
  AgentRole,
  OrganizationWorkspaceEntryMutationResult,
  OrganizationWorkspaceFileDetail,
  OrganizationWorkspaceFileEntry,
  OrganizationWorkspaceFileList,
  OrganizationWorkspaceRootSource,
} from "@rudderhq/shared";
import {
  buildLibraryEntryMentionHref,
  buildLibraryEntryMentionMarkdown,
} from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { resolveStoredOrDerivedAgentWorkspaceKey } from "../agent-workspace-key.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { ensureOrganizationWorkspaceLayout, resolveOrganizationWorkspaceRoot } from "../home-paths.js";
import { libraryEntryService } from "./library-entries.js";
import { organizationService } from "./orgs.js";

const HIDDEN_WORKSPACE_ENTRY_NAMES = new Set([".DS_Store", ".cache", ".npm", ".nvm"]);
const PROTECTED_LIBRARY_SYSTEM_ROOTS = new Set(["agents", "skills"]);
const PROTECTED_AGENT_INSTRUCTIONS_FILE_NAMES = new Set(["HEARTBEAT.MD", "MEMORY.MD", "SOUL.MD", "TOOLS.MD"]);
const PROTECTED_AGENT_MANAGED_DIRECTORY_NAMES = new Set(["memory", "skills"]);
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
const DEFAULT_MENTIONABLE_WORKSPACE_FILES_LIMIT = 200;
const MAX_MENTIONABLE_WORKSPACE_FILES_LIMIT = 500;

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

function workspaceFileLabel(filePath: string) {
  return filePath.split("/").filter(Boolean).at(-1) ?? filePath;
}

function workspaceFileReferenceFields(filePath: string, libraryEntryId: string | null) {
  if (!libraryEntryId) {
    return {
      mentionHref: null,
      markdownLink: null,
    };
  }
  const label = workspaceFileLabel(filePath);
  return {
    mentionHref: buildLibraryEntryMentionHref(libraryEntryId, label, filePath),
    markdownLink: buildLibraryEntryMentionMarkdown(libraryEntryId, label, filePath),
  };
}

function resolveWithinRoot(rootPath: string, requestedPath: string) {
  const normalizedPath = normalizeRequestedPath(requestedPath);
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = normalizedPath ? path.resolve(resolvedRoot, normalizedPath) : resolvedRoot;
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw unprocessable("Requested path must stay inside the organization Library root");
  }
  return {
    resolvedRoot,
    resolvedTarget,
    normalizedPath: toPortableRelativePath(relative === "" ? "" : relative),
  };
}

function isProtectedAgentWorkspaceContainerPath(normalizedPath: string) {
  if (normalizedPath === "agents") return true;
  const segments = normalizedPath.split("/").filter(Boolean);
  return segments.length === 2 && segments[0] === "agents";
}

function isProtectedAgentInstructionsEntryPath(normalizedPath: string) {
  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments.length === 3) {
    return segments[0] === "agents" && segments[2] === "instructions";
  }
  if (segments.length === 4 && segments[0] === "agents" && segments[2] === "instructions") {
    return PROTECTED_AGENT_INSTRUCTIONS_FILE_NAMES.has(segments[3]?.toUpperCase() ?? "");
  }
  return false;
}

function isProtectedAgentManagedEntryPath(normalizedPath: string) {
  const segments = normalizedPath.split("/").filter(Boolean);
  return segments.length >= 3
    && segments[0] === "agents"
    && PROTECTED_AGENT_MANAGED_DIRECTORY_NAMES.has(segments[2]?.toLowerCase() ?? "");
}

function isProtectedOrganizationSkillsEntryPath(normalizedPath: string) {
  return normalizedPath.split("/").filter(Boolean)[0]?.toLowerCase() === "skills";
}

function isProtectedLibraryResourcePath(normalizedPath: string) {
  const root = normalizedPath.split("/").filter(Boolean)[0] ?? "";
  return PROTECTED_LIBRARY_SYSTEM_ROOTS.has(root);
}

function assertMutableWorkspaceEntry(normalizedPath: string) {
  if (!normalizedPath) {
    throw unprocessable("The organization Library root cannot be renamed or deleted");
  }
  if (isProtectedAgentWorkspaceContainerPath(normalizedPath)) {
    throw unprocessable("Agent directory entries can only be copied by path");
  }
  if (isProtectedAgentInstructionsEntryPath(normalizedPath)) {
    throw unprocessable("Protected agent instruction entries can only be copied or edited");
  }
  if (isProtectedAgentManagedEntryPath(normalizedPath)) {
    throw unprocessable("Protected agent managed directory entries can only be copied or edited");
  }
  if (isProtectedOrganizationSkillsEntryPath(normalizedPath)) {
    throw unprocessable("Organization skill entries can only be copied or edited");
  }
}

function assertCanCreateWorkspaceEntry(normalizedPath: string) {
  const parentPath = toPortableRelativePath(path.dirname(normalizedPath));
  if (isProtectedAgentWorkspaceContainerPath(parentPath === "." ? "" : parentPath)) {
    throw unprocessable("Agent workspace root folders can only be copied by path");
  }
}

function normalizeEntryName(name: string) {
  const nextName = name.trim();
  if (!nextName) throw unprocessable("Entry name is required");
  if (nextName === "." || nextName === "..") {
    throw unprocessable("Entry name cannot be a relative path segment");
  }
  if (nextName.includes("/") || nextName.includes("\\") || path.basename(nextName) !== nextName) {
    throw unprocessable("Entry name must not include path separators");
  }
  return nextName;
}

async function statWorkspaceEntry(targetPath: string) {
  return await fs.stat(targetPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
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
  const libraryEntries = libraryEntryService(db);

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

  async function attachLibraryEntryIds(
    orgId: string,
    entries: OrganizationWorkspaceFileEntry[],
  ): Promise<OrganizationWorkspaceFileEntry[]> {
    return await Promise.all(entries.map(async (entry) => {
      if (entry.isDirectory) return entry;
      const libraryEntry = await libraryEntries.getOrCreateWorkspaceFileEntry(orgId, entry.path);
      return {
        ...entry,
        libraryEntryId: libraryEntry.id,
      };
    }));
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
          message: "The shared Library root is not available on this machine yet.",
        };
      }

      if (!(await pathExistsAsDirectory(resolvedTarget))) {
        throw notFound("Directory not found inside the organization Library");
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
      const decoratedEntries = await attachLibraryEntryIds(
        orgId,
        await decorateWorkspaceEntries(orgId, normalizedPath, unsortedEntries),
      );
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

    async listMentionableFiles(orgId: string, options?: {
      query?: string | null;
      limit?: number | null;
    }): Promise<OrganizationWorkspaceFileEntry[]> {
      const root = await resolveWorkspaceRoot(orgId);
      const { resolvedRoot } = resolveWithinRoot(root.rootPath, "");
      const rootExists = await pathExistsAsDirectory(resolvedRoot);
      if (!rootExists) return [];

      const entries: OrganizationWorkspaceFileEntry[] = [];
      const normalizedQuery = options?.query?.trim().toLowerCase() ?? "";
      const requestedLimit = options?.limit ?? DEFAULT_MENTIONABLE_WORKSPACE_FILES_LIMIT;
      const limit = Math.max(1, Math.min(MAX_MENTIONABLE_WORKSPACE_FILES_LIMIT, requestedLimit));
      async function visit(directoryPath: string) {
        if (entries.length >= limit) return;
        if (isProtectedLibraryResourcePath(directoryPath)) return;

        const directoryAbsolutePath = directoryPath
          ? path.join(resolvedRoot, ...directoryPath.split("/"))
          : resolvedRoot;
        const rawEntries = (await fs.readdir(directoryAbsolutePath, { withFileTypes: true }).catch(() => []))
          .sort((left, right) => left.name.localeCompare(right.name));

        for (const entry of rawEntries) {
          if (entries.length >= limit) break;
          if (shouldHideWorkspaceEntry(entry.name)) continue;
          const entryPath = directoryPath ? `${directoryPath}/${entry.name}` : entry.name;
          if (isProtectedLibraryResourcePath(entryPath)) continue;
          if (entry.isDirectory()) {
            if (!normalizedQuery || `${entry.name} ${entryPath}`.toLowerCase().includes(normalizedQuery)) {
              entries.push({
                name: entry.name,
                path: entryPath,
                isDirectory: true,
              });
              if (entries.length >= limit) break;
            }
            await visit(entryPath);
            continue;
          }
          if (!entry.isFile()) continue;
          if (normalizedQuery) {
            const searchable = `${entry.name} ${entryPath}`.toLowerCase();
            if (!searchable.includes(normalizedQuery)) continue;
          }
          entries.push({
            name: entry.name,
            path: entryPath,
            isDirectory: false,
          });
        }
      }

      await visit("");
      const decoratedEntries = await attachLibraryEntryIds(orgId, entries);
      return decoratedEntries.sort((left, right) => left.path.localeCompare(right.path));
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
          libraryEntryId: null,
          ...workspaceFileReferenceFields(normalizedPath, null),
          rootExists: false,
          content: null,
          contentType: null,
          previewKind: "binary",
          contentPath: null,
          message: "The shared Library root is not available on this machine yet.",
          truncated: false,
        };
      }

      if (!(await pathExistsAsFile(resolvedTarget))) {
        throw notFound("File not found inside the organization Library");
      }

      const buffer = await fs.readFile(resolvedTarget);
      const contentType = getWorkspaceFileContentType(normalizedPath || resolvedTarget, buffer) ?? "application/octet-stream";
      const previewKind = getWorkspaceFilePreviewKind(contentType, buffer);
      const libraryEntry = await libraryEntries.getOrCreateWorkspaceFileEntry(orgId, normalizedPath);
      if (previewKind === "image") {
        return {
          source: root.source,
          rootPath: resolvedRoot,
          repoUrl: root.repoUrl,
          filePath: normalizedPath,
          libraryEntryId: libraryEntry.id,
          ...workspaceFileReferenceFields(normalizedPath, libraryEntry.id),
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
          libraryEntryId: libraryEntry.id,
          ...workspaceFileReferenceFields(normalizedPath, libraryEntry.id),
          rootExists: true,
          content: null,
          contentType,
          previewKind,
          contentPath: null,
          message: "Binary files cannot be rendered in Docs.",
          truncated: false,
        };
      }

      return {
        source: root.source,
        rootPath: resolvedRoot,
        repoUrl: root.repoUrl,
        filePath: normalizedPath,
        libraryEntryId: libraryEntry.id,
        ...workspaceFileReferenceFields(normalizedPath, libraryEntry.id),
        rootExists: true,
        content: buffer.toString("utf8"),
        contentType,
        previewKind,
        contentPath: null,
        message: null,
        truncated: false,
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
        throw notFound("The shared Library root is not available on this machine yet.");
      }
      if (!(await pathExistsAsFile(resolvedTarget))) {
        throw notFound("File not found inside the organization Library");
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
        throw notFound("The shared Library root is not available on this machine yet.");
      }
      if (!(await pathExistsAsFile(resolvedTarget))) {
        throw notFound("File not found inside the organization Library");
      }

      await fs.writeFile(resolvedTarget, content, "utf8");
      const libraryEntry = await libraryEntries.getOrCreateWorkspaceFileEntry(orgId, normalizedPath);

      return {
        source: root.source,
        rootPath: resolvedRoot,
        repoUrl: root.repoUrl,
        filePath: normalizedPath,
        libraryEntryId: libraryEntry.id,
        ...workspaceFileReferenceFields(normalizedPath, libraryEntry.id),
        rootExists: true,
        content,
        contentType: getWorkspaceFileContentType(normalizedPath || resolvedTarget) ?? "text/plain",
        previewKind: "text",
        contentPath: null,
        message: null,
        truncated: false,
      };
    },

    async createFile(
      orgId: string,
      filePath: string,
      content: string,
    ): Promise<OrganizationWorkspaceFileDetail> {
      const root = await resolveWorkspaceRoot(orgId);
      const { resolvedRoot, resolvedTarget, normalizedPath } = resolveWithinRoot(root.rootPath, filePath);
      const rootExists = await pathExistsAsDirectory(resolvedRoot);
      if (!rootExists) {
        throw notFound("The shared Library root is not available on this machine yet.");
      }
      if (!normalizedPath) {
        throw unprocessable("File path is required");
      }
      assertCanCreateWorkspaceEntry(normalizedPath);
      if (await statWorkspaceEntry(resolvedTarget)) {
        throw conflict("A file or folder already exists at that path");
      }

      await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });
      await fs.writeFile(resolvedTarget, content, { encoding: "utf8", flag: "wx" });
      const libraryEntry = await libraryEntries.getOrCreateWorkspaceFileEntry(orgId, normalizedPath);

      return {
        source: root.source,
        rootPath: resolvedRoot,
        repoUrl: root.repoUrl,
        filePath: normalizedPath,
        libraryEntryId: libraryEntry.id,
        ...workspaceFileReferenceFields(normalizedPath, libraryEntry.id),
        rootExists: true,
        content,
        contentType: getWorkspaceFileContentType(normalizedPath || resolvedTarget) ?? "text/plain",
        previewKind: "text",
        contentPath: null,
        message: null,
        truncated: false,
      };
    },

    async createDirectory(
      orgId: string,
      directoryPath: string,
    ): Promise<OrganizationWorkspaceEntryMutationResult> {
      const root = await resolveWorkspaceRoot(orgId);
      const { resolvedRoot, resolvedTarget, normalizedPath } = resolveWithinRoot(root.rootPath, directoryPath);
      const rootExists = await pathExistsAsDirectory(resolvedRoot);
      if (!rootExists) {
        throw notFound("The shared Library root is not available on this machine yet.");
      }
      if (!normalizedPath) {
        throw unprocessable("Directory path is required");
      }
      assertCanCreateWorkspaceEntry(normalizedPath);
      if (await statWorkspaceEntry(resolvedTarget)) {
        throw conflict("A file or folder already exists at that path");
      }

      await fs.mkdir(resolvedTarget, { recursive: false });
      return {
        path: normalizedPath,
        isDirectory: true,
      };
    },

    async renameEntry(
      orgId: string,
      entryPath: string,
      name: string,
    ): Promise<OrganizationWorkspaceEntryMutationResult> {
      const root = await resolveWorkspaceRoot(orgId);
      const { resolvedRoot, resolvedTarget, normalizedPath } = resolveWithinRoot(root.rootPath, entryPath);
      const rootExists = await pathExistsAsDirectory(resolvedRoot);
      if (!rootExists) {
        throw notFound("The shared Library root is not available on this machine yet.");
      }
      assertMutableWorkspaceEntry(normalizedPath);

      const stat = await statWorkspaceEntry(resolvedTarget);
      if (!stat) {
        throw notFound("Entry not found inside the organization Library");
      }

      const nextName = normalizeEntryName(name);
      const nextTarget = path.resolve(path.dirname(resolvedTarget), nextName);
      const relative = path.relative(resolvedRoot, nextTarget);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw unprocessable("Entry path must stay inside the organization Library root");
      }
      const nextPath = toPortableRelativePath(relative);
      if (isProtectedAgentWorkspaceContainerPath(nextPath)) {
        throw unprocessable("Entries cannot be moved into the protected agent area");
      }
      if (normalizedPath === nextPath) {
        return {
          previousPath: normalizedPath,
          path: normalizedPath,
          isDirectory: stat.isDirectory(),
        };
      }
      if (await statWorkspaceEntry(nextTarget)) {
        throw conflict("An entry with that name already exists");
      }

      await fs.rename(resolvedTarget, nextTarget);
      const libraryEntry = stat.isDirectory()
        ? (await libraryEntries.moveWorkspaceDirectoryEntries(orgId, normalizedPath, nextPath), null)
        : await libraryEntries.moveWorkspaceFileEntry(orgId, normalizedPath, nextPath);
      return {
        previousPath: normalizedPath,
        path: nextPath,
        isDirectory: stat.isDirectory(),
        libraryEntryId: libraryEntry?.id ?? null,
      };
    },

    async moveEntry(
      orgId: string,
      entryPath: string,
      destinationDirectoryPath: string,
    ): Promise<OrganizationWorkspaceEntryMutationResult> {
      const root = await resolveWorkspaceRoot(orgId);
      const { resolvedRoot, resolvedTarget, normalizedPath } = resolveWithinRoot(root.rootPath, entryPath);
      const {
        resolvedTarget: resolvedDestinationDirectory,
        normalizedPath: normalizedDestinationDirectory,
      } = resolveWithinRoot(root.rootPath, destinationDirectoryPath);
      const rootExists = await pathExistsAsDirectory(resolvedRoot);
      if (!rootExists) {
        throw notFound("The shared Library root is not available on this machine yet.");
      }
      assertMutableWorkspaceEntry(normalizedPath);
      if (isProtectedAgentWorkspaceContainerPath(normalizedDestinationDirectory)) {
        throw unprocessable("Entries cannot be moved into the protected agent area");
      }

      const stat = await statWorkspaceEntry(resolvedTarget);
      if (!stat) {
        throw notFound("Entry not found inside the organization Library");
      }
      if (!(await pathExistsAsDirectory(resolvedDestinationDirectory))) {
        throw notFound("Destination directory not found inside the organization Library");
      }
      if (stat.isDirectory()) {
        const relativeDestination = path.relative(resolvedTarget, resolvedDestinationDirectory);
        if (relativeDestination === "" || (!relativeDestination.startsWith("..") && !path.isAbsolute(relativeDestination))) {
          throw unprocessable("A folder cannot be moved into itself or one of its children");
        }
      }

      const nextTarget = path.resolve(resolvedDestinationDirectory, path.basename(resolvedTarget));
      const nextRelativePath = path.relative(resolvedRoot, nextTarget);
      if (nextRelativePath.startsWith("..") || path.isAbsolute(nextRelativePath)) {
        throw unprocessable("Entry path must stay inside the organization Library root");
      }
      const nextPath = toPortableRelativePath(nextRelativePath);
      assertCanCreateWorkspaceEntry(nextPath);
      if (normalizedPath === nextPath) {
        return {
          previousPath: normalizedPath,
          path: normalizedPath,
          isDirectory: stat.isDirectory(),
        };
      }
      if (await statWorkspaceEntry(nextTarget)) {
        throw conflict("An entry with that name already exists in the destination directory");
      }

      await fs.rename(resolvedTarget, nextTarget);
      const libraryEntry = stat.isDirectory()
        ? (await libraryEntries.moveWorkspaceDirectoryEntries(orgId, normalizedPath, nextPath), null)
        : await libraryEntries.moveWorkspaceFileEntry(orgId, normalizedPath, nextPath);
      return {
        previousPath: normalizedPath,
        path: nextPath,
        isDirectory: stat.isDirectory(),
        libraryEntryId: libraryEntry?.id ?? null,
      };
    },

    async deleteEntry(orgId: string, entryPath: string): Promise<OrganizationWorkspaceEntryMutationResult> {
      const root = await resolveWorkspaceRoot(orgId);
      const { resolvedRoot, resolvedTarget, normalizedPath } = resolveWithinRoot(root.rootPath, entryPath);
      const rootExists = await pathExistsAsDirectory(resolvedRoot);
      if (!rootExists) {
        throw notFound("The shared Library root is not available on this machine yet.");
      }
      assertMutableWorkspaceEntry(normalizedPath);

      const stat = await statWorkspaceEntry(resolvedTarget);
      if (!stat) {
        throw notFound("Entry not found inside the organization Library");
      }

      await fs.rm(resolvedTarget, { recursive: true, force: false });
      const libraryEntry = stat.isDirectory()
        ? (await libraryEntries.markWorkspaceDirectoryEntriesDeleted(orgId, normalizedPath), null)
        : await libraryEntries.markWorkspaceFileEntryDeleted(orgId, normalizedPath);
      return {
        path: normalizedPath,
        isDirectory: stat.isDirectory(),
        libraryEntryId: libraryEntry?.id ?? null,
      };
    },
  };
}
