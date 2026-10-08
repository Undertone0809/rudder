import type { Response } from "express";
import os from "node:os";
import { HttpError } from "../errors.js";
import type { CurrentUserRedactionOptions } from "../log-redaction.js";
import type { RustFoundationActor, RustFoundationBridge } from "./rust-foundation-bridge.js";

export type RunReadRedaction = { userNames: string[]; homeDirs: string[]; replacement: string };
export type RunReadInput =
  | { operation: "list"; surface: "heartbeat" | "agent"; agentId: string | null; goalId: string | null; startDate: string | null; endDate: string | null; limit: number | null }
  | { operation: "overview" }
  | { operation: "visibility"; runId: string }
  | { operation: "workspaceOperationAccess"; operationId: string }
  | { operation: "detail"; surface: "heartbeat" | "agent"; runId: string; redaction: RunReadRedaction }
  | { operation: "events"; runId: string; afterSeq: number; limit: number; redaction: RunReadRedaction }
  | { operation: "workspaceOperations"; runId: string; redaction: RunReadRedaction }
  | { operation: "active"; issueId: string; redaction: RunReadRedaction };

/** Environment metadata is resolved at the Node boundary; native code owns all
 * public projections and masking. No private run payload crosses this boundary. */
export function runReadRedaction(options: CurrentUserRedactionOptions = {}): RunReadRedaction {
  const unique = (values: Array<string | undefined>) => [...new Set(values.map((v) => v?.trim() ?? "").filter(Boolean))];
  let user: string | undefined;
  let home: string | undefined;
  try { user = os.userInfo().username; } catch { /* Environment may lack passwd. */ }
  try { home = os.homedir(); } catch { /* Environment hints remain available. */ }
  const userNames = unique(options.userNames ?? [process.env.USER, process.env.LOGNAME, process.env.USERNAME, user]);
  const homeDirs = unique(options.homeDirs ?? [process.env.HOME, process.env.USERPROFILE, home,
    ...userNames.flatMap((name) => [`/Users/${name}`, `/home/${name}`, `C:\\Users\\${name}`])]);
  return { userNames, homeDirs, replacement: options.replacement?.trim() || "*" };
}

export async function sendRunRead(res: Response, bridge: RustFoundationBridge | undefined,
  actor: RustFoundationActor, orgId: string, input: RunReadInput): Promise<void> {
  if (!bridge?.runRead) throw new HttpError(503, "Rust run reads are unavailable");
  let response;
  try { response = await bridge.runRead(actor, orgId, input); }
  catch { throw new HttpError(503, "Rust run reads are unavailable"); }
  res.status(response.status).type(response.contentType).send(response.body);
}

/** Authorization-only transport; Rust decides ownership from its signed actor. */
export async function requireRunReadAccess(bridge: RustFoundationBridge | undefined,
  actor: RustFoundationActor, orgId: string,
  input: { operation: "visibility"; runId: string } | { operation: "workspaceOperationAccess"; operationId: string },
  notFoundMessage: string): Promise<void> {
  if (!bridge?.runRead) throw new HttpError(503, "Rust run authorization is unavailable");
  let response;
  try { response = await bridge.runRead(actor, orgId, input); }
  catch { throw new HttpError(503, "Rust run authorization is unavailable"); }
  if (response.status === 204) return;
  if (response.status === 404) throw new HttpError(404, notFoundMessage);
  throw new HttpError(503, "Rust run authorization is unavailable");
}
