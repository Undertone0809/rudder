import { parseCodexInlineVisualDirectives } from "@rudderhq/shared";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const CODEX_INLINE_VISUAL_MAX_BYTES = 2 * 1024 * 1024;
const CODEX_INLINE_VISUAL_TIME_SKEW_MS = 5_000;

export type CapturedCodexInlineVisual =
  | {
    directiveIndex: number;
    file: string;
    status: "captured";
    contentType: "text/html";
    byteSize: number;
    bodyBase64: string;
  }
  | {
    directiveIndex: number;
    file: string;
    status: "unavailable";
    reason: "missing" | "out_of_window" | "path_escape" | "too_large" | "unreadable";
  };

export function codexInlineVisualDirectiveBody(summary: string) {
  const firstBrace = summary.indexOf("{");
  const lastBrace = summary.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) return summary;
  try {
    const envelope = JSON.parse(summary.slice(firstBrace, lastBrace + 1));
    if (envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
      const body = (envelope as Record<string, unknown>).body;
      if (typeof body === "string") return body;
    }
  } catch {
    // Plain assistant text can contain braces; only a complete JSON envelope is decoded.
  }
  return summary;
}

function dateParts(date: Date, utc: boolean) {
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1;
  const day = utc ? date.getUTCDate() : date.getDate();
  return [String(year), String(month).padStart(2, "0"), String(day).padStart(2, "0")];
}

export function codexVisualizationThreadDirectory(
  codexHome: string,
  threadId: string,
  date: Date,
) {
  return path.join(codexHome, "visualizations", ...dateParts(date, false), threadId);
}

function candidateThreadDirectories(input: {
  codexHome: string;
  threadId: string;
  startedAt: Date;
  endedAt: Date;
}) {
  const dates = new Map<string, string[]>();
  for (const date of [input.startedAt, input.endedAt]) {
    for (const utc of [false, true]) {
      const parts = dateParts(date, utc);
      dates.set(parts.join("/"), parts);
    }
  }
  return [...dates.values()].map((parts) =>
    path.join(input.codexHome, "visualizations", ...parts, input.threadId)
  );
}

function pathIsInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function resolveThreadDirectory(input: {
  codexHome: string;
  threadId: string;
  startedAt: Date;
  endedAt: Date;
}) {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(input.threadId)) return { status: "path_escape" as const };
  const realHome = await fs.realpath(input.codexHome).catch(() => null);
  if (!realHome) return { status: "missing" as const };
  const visualizationRoot = path.resolve(input.codexHome, "visualizations");
  const realRoot = await fs.realpath(visualizationRoot).catch(() => null);
  if (!realRoot) return { status: "missing" as const };
  if (!pathIsInside(realHome, realRoot)) return { status: "path_escape" as const };

  for (const candidate of candidateThreadDirectories(input)) {
    const realCandidate = await fs.realpath(candidate).catch(() => null);
    if (!realCandidate) continue;
    if (!pathIsInside(realRoot, realCandidate) || path.basename(realCandidate) !== input.threadId) {
      return { status: "path_escape" as const };
    }
    const stats = await fs.lstat(candidate).catch(() => null);
    if (!stats?.isDirectory() || stats.isSymbolicLink()) return { status: "path_escape" as const };
    return { status: "ready" as const, directory: realCandidate };
  }
  return { status: "missing" as const };
}

export async function captureCodexInlineVisuals(input: {
  body: string;
  codexHome: string;
  threadId: string;
  startedAt: Date;
  endedAt: Date;
}): Promise<CapturedCodexInlineVisual[]> {
  const { directives } = parseCodexInlineVisualDirectives(input.body);
  if (directives.length === 0) return [];

  const thread = await resolveThreadDirectory(input);
  if (thread.status !== "ready") {
    return directives.map((directive) => ({
      directiveIndex: directive.index,
      file: directive.file,
      status: "unavailable",
      reason: thread.status,
    }));
  }

  const captured: CapturedCodexInlineVisual[] = [];
  for (const directive of directives) {
    const candidate = path.join(thread.directory, directive.file);
    const realCandidate = await fs.realpath(candidate).catch(() => null);
    if (!realCandidate) {
      captured.push({ directiveIndex: directive.index, file: directive.file, status: "unavailable", reason: "missing" });
      continue;
    }
    if (!pathIsInside(thread.directory, realCandidate)) {
      captured.push({ directiveIndex: directive.index, file: directive.file, status: "unavailable", reason: "path_escape" });
      continue;
    }
    const handle = await fs.open(realCandidate, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    if (!handle) {
      captured.push({ directiveIndex: directive.index, file: directive.file, status: "unavailable", reason: "unreadable" });
      continue;
    }
    let body: Buffer | null = null;
    let failure: "out_of_window" | "path_escape" | "too_large" | "unreadable" | null = null;
    try {
      const openedStats = await handle.stat();
      if (!openedStats.isFile()) failure = "unreadable";
      else if (openedStats.size > CODEX_INLINE_VISUAL_MAX_BYTES) failure = "too_large";
      else if (
        openedStats.mtimeMs < Math.min(input.startedAt.getTime(), input.endedAt.getTime()) - CODEX_INLINE_VISUAL_TIME_SKEW_MS
        || openedStats.mtimeMs > Math.max(input.startedAt.getTime(), input.endedAt.getTime()) + CODEX_INLINE_VISUAL_TIME_SKEW_MS
      ) failure = "out_of_window";
      else {
        const revalidatedPath = await fs.realpath(realCandidate).catch(() => null);
        const revalidatedStats = revalidatedPath ? await fs.stat(revalidatedPath).catch(() => null) : null;
        if (
          !revalidatedPath
          || !pathIsInside(thread.directory, revalidatedPath)
          || !revalidatedStats
          || revalidatedStats.dev !== openedStats.dev
          || revalidatedStats.ino !== openedStats.ino
        ) failure = "path_escape";
        else {
          const bounded = Buffer.allocUnsafe(CODEX_INLINE_VISUAL_MAX_BYTES + 1);
          let bytesRead = 0;
          try {
            while (bytesRead < bounded.length) {
              const chunk = await handle.read(
                bounded,
                bytesRead,
                bounded.length - bytesRead,
                bytesRead,
              );
              if (chunk.bytesRead === 0) break;
              bytesRead += chunk.bytesRead;
            }
            if (bytesRead > CODEX_INLINE_VISUAL_MAX_BYTES) failure = "too_large";
            else {
              const finalStats = await handle.stat();
              if (
                finalStats.size !== openedStats.size
                || finalStats.mtimeMs !== openedStats.mtimeMs
              ) failure = "unreadable";
              else body = bounded.subarray(0, bytesRead);
            }
          } catch {
            failure = "unreadable";
          }
        }
      }
    } finally {
      await handle.close();
    }
    if (failure || !body) {
      captured.push({
        directiveIndex: directive.index,
        file: directive.file,
        status: "unavailable",
        reason: failure ?? "unreadable",
      });
      continue;
    }
    captured.push({
      directiveIndex: directive.index,
      file: directive.file,
      status: "captured",
      contentType: "text/html",
      byteSize: body.length,
      bodyBase64: body.toString("base64"),
    });
  }
  return captured;
}
