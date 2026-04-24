import path from "node:path";
import fs from "node:fs/promises";
import { agents, type Db } from "@rudderhq/db";
import type {
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

export function organizationWorkspaceBrowserService(db: Db) {
  const orgs = organizationService(db);

  async function listAgentWorkspaceDirectoryMap(orgId: string) {
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
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
          message: "The workspace root is not available on this machine yet.",
          truncated: false,
        };
      }

      if (!(await pathExistsAsFile(resolvedTarget))) {
        throw notFound("File not found inside the organization workspace");
      }

      const buffer = await fs.readFile(resolvedTarget);
      if (hasBinaryBytes(buffer)) {
        return {
          source: root.source,
          rootPath: resolvedRoot,
          repoUrl: root.repoUrl,
          filePath: normalizedPath,
          rootExists: true,
          content: null,
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
        message: truncated ? "Preview truncated to the first 200 KB." : null,
        truncated,
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
        message: null,
        truncated: false,
      };
    },
  };
}
