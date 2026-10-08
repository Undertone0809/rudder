import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError } from "../errors.js";
import type { RustFoundationBridge } from "./rust-foundation-bridge.js";

const RESPONSE_HEADERS = [
  "content-type", "content-length", "content-disposition", "cache-control",
  "x-content-type-options", "x-rudder-archive-sha256",
] as const;

/** Node retains authentication and HTTP transport; all artifact selection,
 * validation, projection and archive creation belong to the Rust capability.
 * Never revive the legacy reader after a native failure. */
export async function sendWorkspaceBackupRead(
  req: Request,
  res: Response,
  bridge: RustFoundationBridge | undefined,
  orgId: string,
  input: { backupId: string; operation: "files" | "file" | "download"; path: string },
): Promise<void> {
  if (!bridge?.workspaceBackupRead) throw new HttpError(503, "Rust workspace backup reads are unavailable");
  const controller = new AbortController();
  const disconnected = () => controller.abort();
  req.once("aborted", disconnected);
  res.once("close", disconnected);
  try {
    let response: globalThis.Response;
    try {
      response = await bridge.workspaceBackupRead(req, orgId, input, controller.signal);
    } catch {
      throw new HttpError(503, "Rust workspace backup reads are unavailable");
    }
    if (!response.ok) {
      // Consume failures before sending headers. Never propagate download
      // headers on an error or turn a truncated native error into success.
      const payload = await response.json() as { error?: unknown };
      if (typeof payload.error !== "string") throw new HttpError(503, "Rust workspace backup reads are unavailable");
      res.status(response.status).json({ error: payload.error });
      return;
    }
    if (!response.body) throw new HttpError(503, "Rust workspace backup reads are unavailable");
    res.status(response.status);
    for (const name of RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) res.setHeader(name, value);
    }
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res);
  } finally {
    req.off("aborted", disconnected);
    res.off("close", disconnected);
    controller.abort();
  }
}
