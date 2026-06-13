import type {
  OrganizationWorkspaceFileDetail,
  OrganizationWorkspaceFileList,
} from "@rudderhq/shared";
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAgentCliCapabilityById } from "../../agent-v1-registry.js";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface LibraryFilePutOptions extends BaseClientOptions {
  bodyFile?: string;
}

interface LibraryFileLinkResult {
  filePath: string;
  libraryEntryId: string | null;
  mentionHref: string | null;
  markdownLink: string | null;
}

function toLibraryFileLinkResult(detail: OrganizationWorkspaceFileDetail): LibraryFileLinkResult {
  return {
    filePath: detail.filePath,
    libraryEntryId: detail.libraryEntryId,
    mentionHref: detail.mentionHref,
    markdownLink: detail.markdownLink,
  };
}

async function printLibraryFileReference(filePath: string, opts: BaseClientOptions): Promise<void> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  const search = new URLSearchParams();
  search.set("path", filePath.trim());
  const result = await ctx.api.get<OrganizationWorkspaceFileDetail>(
    `/api/orgs/${ctx.orgId}/workspace/file?${search.toString()}`,
  );
  if (!result) throw new Error("Library file not found");
  printOutput(toLibraryFileLinkResult(result), { json: ctx.json });
}

export function registerLibraryCommands(program: Command): void {
  const library = program.command("library").description("Library file operations");
  const file = library.command("file").description("Library file operations");

  addCommonClientOptions(
    file
      .command("list")
      .description(getAgentCliCapabilityById("library.file.list").description)
      .argument("[directoryPath]", "Library directory path", "projects")
      .action(async (directoryPath: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const search = new URLSearchParams();
          const normalizedPath = directoryPath.trim();
          if (normalizedPath) search.set("path", normalizedPath);
          const query = search.toString();
          const result = await ctx.api.get<OrganizationWorkspaceFileList>(
            `/api/orgs/${ctx.orgId}/workspace/files${query ? `?${query}` : ""}`,
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    file
      .command("get")
      .description(getAgentCliCapabilityById("library.file.get").description)
      .argument("<filePath>", "Library file path")
      .action(async (filePath: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const search = new URLSearchParams();
          search.set("path", filePath.trim());
          const result = await ctx.api.get<OrganizationWorkspaceFileDetail>(
            `/api/orgs/${ctx.orgId}/workspace/file?${search.toString()}`,
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    file
      .command("link")
      .description(getAgentCliCapabilityById("library.file.link").description)
      .argument("<filePath>", "Library file path")
      .action(async (filePath: string, opts: BaseClientOptions) => {
        try {
          await printLibraryFileReference(filePath, opts);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    file
      .command("ref")
      .description(getAgentCliCapabilityById("library.file.ref").description)
      .argument("<filePath>", "Library file path")
      .action(async (filePath: string, opts: BaseClientOptions) => {
        try {
          await printLibraryFileReference(filePath, opts);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    file
      .command("put")
      .description(getAgentCliCapabilityById("library.file.put").description)
      .argument("<filePath>", "Library file path")
      .option("--body-file <path>", "Read file content from a file, or '-' for stdin")
      .action(async (filePath: string, opts: LibraryFilePutOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const body = await resolveBodyFileInput(opts.bodyFile);
          const search = new URLSearchParams();
          search.set("path", filePath.trim());
          const updatePath = `/api/orgs/${ctx.orgId}/workspace/file?${search.toString()}`;
          const updated = await ctx.api.patch<OrganizationWorkspaceFileDetail>(
            updatePath,
            { content: body },
            { ignoreNotFound: true },
          );
          if (updated) {
            printOutput(updated, { json: ctx.json });
            return;
          }

          const created = await ctx.api.post<OrganizationWorkspaceFileDetail>(
            `/api/orgs/${ctx.orgId}/workspace/file`,
            { filePath: filePath.trim(), content: body },
          );
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}

async function resolveBodyFileInput(inputPath: string | undefined): Promise<string> {
  if (process.argv.includes("--body")) {
    throw new Error("--body was removed; write the body to a file and use --body-file <path> or --body-file - for stdin");
  }
  if (inputPath === undefined) {
    throw new Error("Provide --body-file <path>; use --body-file - for stdin");
  }
  if (inputPath === "-") {
    return readStdinText();
  }
  const resolvedPath = path.resolve(process.cwd(), inputPath);
  return readFile(resolvedPath, "utf8").catch((err: unknown) => {
    throw new Error(`Unable to read --body-file ${inputPath}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
