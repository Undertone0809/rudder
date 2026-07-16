import { randomUUID } from "node:crypto";

export type DesktopStartupFailureCategory =
  | "configuration"
  | "database"
  | "migration"
  | "permission"
  | "port_in_use"
  | "runtime";

export type DesktopStartupFailureView = {
  id: string;
  occurredAt: string;
  stage: string;
  attempt: number;
  category: DesktopStartupFailureCategory;
  summary: string;
};

const FAILURE_COPY: Record<DesktopStartupFailureCategory, string> = {
  configuration: "Rudder could not read a required local configuration.",
  database: "The local database did not start cleanly.",
  migration: "The local database could not finish its migration.",
  permission: "Rudder could not access a required local file or folder.",
  port_in_use: "A local port required by Rudder is already in use.",
  runtime: "The local Rudder runtime did not start cleanly.",
};

function classifyStartupFailure(error: unknown): DesktopStartupFailureCategory {
  const source = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/EADDRINUSE|address already in use/iu.test(source)) return "port_in_use";
  if (/EACCES|EPERM|permission denied|operation not permitted/iu.test(source)) return "permission";
  if (/migration|drizzle|schema drift/iu.test(source)) return "migration";
  if (/postgres|database|initdb|pg_ctl|ECONNREFUSED/iu.test(source)) return "database";
  if (/config|environment|\.env/iu.test(source)) return "configuration";
  return "runtime";
}

export function createDesktopStartupFailureView(input: {
  error: unknown;
  stage: string;
  attempt: number;
  id?: string;
  occurredAt?: string;
}): DesktopStartupFailureView {
  const category = classifyStartupFailure(input.error);
  return {
    id: input.id ?? randomUUID(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    stage: input.stage.trim().slice(0, 40) || "starting",
    attempt: Math.max(1, Math.trunc(input.attempt)),
    category,
    summary: FAILURE_COPY[category],
  };
}

function cleanDiagnosticField(value: string | null | undefined, maxLength = 160): string | null {
  const cleaned = value
    ?.replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

export function createDesktopRecoveryDiagnostic(input: {
  failure: DesktopStartupFailureView;
  version: string;
  platform: string;
  arch: string;
  profile?: string | null;
  instance?: string | null;
}): string {
  const rows = [
    ["Failure ID", input.failure.id],
    ["Occurred at", input.failure.occurredAt],
    ["Rudder version", cleanDiagnosticField(input.version, 80)],
    ["System", `${cleanDiagnosticField(input.platform, 40) ?? "unknown"} / ${cleanDiagnosticField(input.arch, 40) ?? "unknown"}`],
    ["Stage", input.failure.stage],
    ["Attempt", String(input.failure.attempt)],
    ["Category", input.failure.category],
    ["Summary", input.failure.summary],
    ["Profile", cleanDiagnosticField(input.profile, 80)],
    ["Instance", cleanDiagnosticField(input.instance, 80)],
  ].filter((row): row is [string, string] => Boolean(row[1]));

  return [
    "Rudder startup diagnostic",
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    "Review this diagnostic before sharing it.",
  ].join("\n");
}
