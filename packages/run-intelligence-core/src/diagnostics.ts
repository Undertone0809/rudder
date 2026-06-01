import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type {
  RunDiagnosticEvidence,
  RunDiagnosticFindingKind,
  RunDiagnosticFindingSeverity,
} from "@rudderhq/shared";
import type { ObservedRunDetail } from "./types.js";

export interface RunDiagnosticDraft {
  kind: RunDiagnosticFindingKind;
  severity: RunDiagnosticFindingSeverity;
  fingerprint: string;
  summary: string;
  detailsJson?: Record<string, unknown> | null;
  evidenceJson: RunDiagnosticEvidence[];
  rawExcerpt?: string | null;
  source?: string;
}

function truncate(value: string, maxLength = 1200) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function normalizeFingerprintPart(value: string) {
  return value
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[0-9a-f]{8,}/g, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\/[^\s]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function fingerprint(parts: Array<string | null | undefined>) {
  return parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .map(normalizeFingerprintPart)
    .join(":");
}

function evidence(label: string, value: unknown): RunDiagnosticEvidence {
  return {
    label,
    value: truncate(String(value ?? ""), 500),
  };
}

function textFromEntry(entry: TranscriptEntry) {
  if (entry.kind === "tool_result") return entry.content;
  if (entry.kind === "stderr" || entry.kind === "system" || entry.kind === "stdout") return entry.text;
  if (entry.kind === "result") return [...(entry.errors ?? []), entry.text ?? ""].filter(Boolean).join("\n");
  return "";
}

function candidateLines(detail: ObservedRunDetail) {
  const values = [
    detail.run.error,
    detail.run.errorCode,
    detail.run.stderrExcerpt,
    detail.run.stdoutExcerpt,
    ...detail.events.map((event) => event.message),
    ...detail.logChunks
      .filter((chunk) => chunk.stream === "stderr" || chunk.stream === "system")
      .map((chunk) => chunk.chunk),
    ...detail.transcript.map(textFromEntry),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return values
    .flatMap((value) => value.split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);
}

function matchFirst(lines: string[], pattern: RegExp) {
  return lines.find((line) => pattern.test(line)) ?? null;
}

function knownSignatureFinding(
  detail: ObservedRunDetail,
  lines: string[],
): RunDiagnosticDraft | null {
  const runtime = detail.bundle.agentRuntimeType;
  const signatures: Array<{
    kind: RunDiagnosticFindingKind;
    severity: RunDiagnosticFindingSeverity;
    pattern: RegExp;
    summary: string;
  }> = [
    {
      kind: "cli_usage_error",
      severity: "error",
      pattern: /required option ['"`]?(--?[a-z0-9][a-z0-9-]*(?:\s+<[^>]+>)?)['"`]? not specified/i,
      summary: "CLI command missed a required option",
    },
    {
      kind: "permission_error",
      severity: "error",
      pattern: /permission denied|operation not permitted/i,
      summary: "Runtime hit a permission error",
    },
    {
      kind: "auth_error",
      severity: "error",
      pattern: /could not read username|authentication failed|unauthorized|401|403/i,
      summary: "Runtime hit an authentication error",
    },
    {
      kind: "dependency_error",
      severity: "error",
      pattern: /cannot find module|module not found|command not found|no such file/i,
      summary: "Runtime missed a dependency, command, or file",
    },
    {
      kind: "network_error",
      severity: "warn",
      pattern: /connection refused|econnrefused|network error|fetch failed/i,
      summary: "Runtime depended on an unavailable network service",
    },
  ];

  for (const signature of signatures) {
    const line = matchFirst(lines, signature.pattern);
    if (!line) continue;
    const optionMatch = line.match(signature.pattern);
    const normalizedDetail = optionMatch?.[1] ?? line;
    return {
      kind: signature.kind,
      severity: signature.severity,
      fingerprint: fingerprint([signature.kind, runtime, normalizedDetail]),
      summary: signature.summary,
      detailsJson: {
        runtime,
        status: detail.run.status,
        pattern: signature.pattern.source,
      },
      evidenceJson: [
        evidence("run", detail.run.id),
        evidence("agent_runtime", runtime),
        evidence("excerpt", line),
      ],
      rawExcerpt: truncate(line),
      source: "run_diagnostics.signature",
    };
  }

  return null;
}

function runFailureFinding(detail: ObservedRunDetail): RunDiagnosticDraft | null {
  if (detail.run.status !== "failed" && detail.run.status !== "timed_out") return null;
  const kind: RunDiagnosticFindingKind = detail.run.status === "timed_out" ? "timeout" : "run_failure";
  const message = detail.run.error ?? detail.run.stderrExcerpt ?? detail.run.errorCode ?? `Run ${detail.run.status}`;
  return {
    kind,
    severity: "error",
    fingerprint: fingerprint([kind, detail.bundle.agentRuntimeType, detail.run.errorCode ?? message]),
    summary: detail.run.status === "timed_out" ? "Run timed out" : "Run failed",
    detailsJson: {
      status: detail.run.status,
      errorCode: detail.run.errorCode,
      exitCode: detail.run.exitCode,
      runtime: detail.bundle.agentRuntimeType,
    },
    evidenceJson: [
      evidence("run", detail.run.id),
      evidence("status", detail.run.status),
      evidence("error", message),
    ],
    rawExcerpt: truncate(message),
    source: "run_diagnostics.status",
  };
}

function toolErrorFindings(detail: ObservedRunDetail): RunDiagnosticDraft[] {
  const findings: RunDiagnosticDraft[] = [];
  for (const entry of detail.transcript) {
    if (entry.kind !== "tool_result" || !entry.isError) continue;
    const toolName = entry.toolName ?? entry.toolUseId ?? "unknown_tool";
    const content = entry.content.trim() || "Tool result reported an error.";
    findings.push({
      kind: "tool_call_error",
      severity: "error",
      fingerprint: fingerprint(["tool_call_error", detail.bundle.agentRuntimeType, toolName, content]),
      summary: `Tool call failed: ${toolName}`,
      detailsJson: {
        runtime: detail.bundle.agentRuntimeType,
        toolName,
        toolUseId: entry.toolUseId,
      },
      evidenceJson: [
        evidence("run", detail.run.id),
        evidence("tool", toolName),
        evidence("excerpt", content),
      ],
      rawExcerpt: truncate(content),
      source: "run_diagnostics.transcript",
    });
  }
  return findings;
}

export function buildRunDiagnosticFindings(detail: ObservedRunDetail): RunDiagnosticDraft[] {
  const findings: RunDiagnosticDraft[] = [];
  const add = (finding: RunDiagnosticDraft | null) => {
    if (!finding) return;
    if (findings.some((existing) => existing.fingerprint === finding.fingerprint)) return;
    findings.push(finding);
  };

  add(runFailureFinding(detail));
  for (const finding of toolErrorFindings(detail)) add(finding);
  add(knownSignatureFinding(detail, candidateLines(detail)));

  return findings;
}
