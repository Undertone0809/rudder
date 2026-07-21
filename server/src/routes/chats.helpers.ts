import type { Request } from "express";
import { isAllowedContentType } from "../attachment-types.js";

export function isMultipartRequest(req: Request) {
  return (req.headers["content-type"] ?? "").toLowerCase().startsWith("multipart/form-data");
}

export function uploadedMessageFiles(req: Request) {
  const files = (req as Request & { files?: unknown }).files;
  const list: unknown[] = Array.isArray(files) ? files : [];
  return list.filter((file): file is { mimetype: string; buffer: Buffer; originalname: string } =>
    typeof file === "object"
    && file !== null
    && Buffer.isBuffer((file as { buffer?: unknown }).buffer),
  );
}

export function validateUploadedMessageFiles(files: Array<{ mimetype: string; buffer: Buffer }>) {
  for (const file of files) {
    const contentType = (file.mimetype || "").toLowerCase();
    if (!isAllowedContentType(contentType)) return `Unsupported attachment type: ${contentType || "unknown"}`;
    if (file.buffer.length <= 0) return "Attachment is empty";
  }
  return null;
}

export function positiveIntegerQuery(value: unknown, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function stringQuery(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function paginateChatMessages<T extends { id: string }>(messages: T[], query: Request["query"]) {
  const order = query.order === "newest" ? "newest" : "oldest";
  const limit = positiveIntegerQuery(query.limit, 50, 500);
  const cursor = stringQuery(query.cursor);
  const ordered = order === "newest" ? [...messages].reverse() : messages;
  const startIndex = cursor ? Math.max(0, ordered.findIndex((message) => message.id === cursor) + 1) : 0;
  const pageMessages = ordered.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + pageMessages.length < ordered.length;
  return {
    messages: pageMessages,
    page: {
      cursor,
      nextCursor: hasMore && pageMessages.length > 0 ? pageMessages[pageMessages.length - 1].id : null,
      hasMore,
      limit,
      order,
      returnedMessages: pageMessages.length,
      totalMessages: messages.length,
    },
  };
}
