import type { KeepMessengerSavedView, UpdateMessengerSavedView } from "@rudderhq/shared";
import type { Response } from "express";
import os from "node:os";
import { HttpError } from "../errors.js";
import type { RustFoundationActor, RustFoundationBridge } from "./rust-foundation-bridge.js";

export type MessengerStateInput =
  | { operation: "savedViewList"; query: { visibility?: "visible" | "hidden" | "all"; limit?: number; offset?: number; primaryRailPinned?: boolean } }
  | { operation: "savedViewGet" | "savedViewDelete"; id: string }
  | { operation: "savedViewKeep"; input: KeepMessengerSavedView }
  | { operation: "savedViewUpdate"; id: string; patch: UpdateMessengerSavedView }
  | { operation: "savedViewReorder"; ids: string[] }
  | { operation: "groupCreate"; name: string; icon: string | null }
  | { operation: "groupUpdate"; groupId: string; patch: { name?: string; icon?: string | null; collapsed?: boolean; pinned?: boolean; sortOrder?: number } }
  | { operation: "groupDelete" | "groupSeparate"; groupId: string }
  | { operation: "groupEntryRemove"; itemKey: string }
  | { operation: "threadUserState"; threadKey: string; pinned?: boolean };

/** Host identity is ambient effect-adapter context, never a user principal.
 * Rust reads the censorship setting and constructs/persists all audit fields. */
export function messengerAuditContext() {
  const unique = (values: Array<string | undefined>) => [...new Set(values.map((v) => v?.trim()).filter((v): v is string => Boolean(v)))];
  let username: string | undefined;
  let home: string | undefined;
  try { username = os.userInfo().username; } catch { /* Environment hints remain available. */ }
  try { home = os.homedir(); } catch { /* Environment hints remain available. */ }
  const userNames = unique([process.env.USER, process.env.LOGNAME, process.env.USERNAME, username]);
  const homeDirs = unique([process.env.HOME, process.env.USERPROFILE, home, ...userNames.flatMap((name) => [`/Users/${name}`, `/home/${name}`, `C:\\Users\\${name}`])]);
  return { userNames, homeDirs };
}

/** Public state operations always select Rust. The existing durable outbox
 * publisher handles committed live events; neither this adapter nor outages
 * may resurrect a Node business query or mutation. */
export async function sendMessengerState(
  res: Response,
  bridge: RustFoundationBridge | undefined,
  actor: RustFoundationActor,
  orgId: string,
  input: MessengerStateInput,
): Promise<void> {
  if (!bridge?.messengerState) throw new HttpError(503, "Rust Messenger state is unavailable");
  let response;
  try {
    response = await bridge.messengerState(actor, orgId, input);
  } catch {
    throw new HttpError(503, "Rust Messenger state is unavailable");
  }
  res.status(response.status).type(response.contentType).send(response.body);
}
