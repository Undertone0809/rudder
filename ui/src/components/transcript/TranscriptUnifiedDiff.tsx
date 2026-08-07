import { Copy } from "lucide-react";
import { cn } from "../../lib/utils";
import { CopyText } from "../CopyText";

export type UnifiedDiffLineKind =
  | "header"
  | "hunk"
  | "context"
  | "add"
  | "remove"
  | "no-newline";

export interface UnifiedDiffLine {
  kind: UnifiedDiffLineKind;
  newLine: number | null;
  oldLine: number | null;
  text: string;
}

export interface ParsedUnifiedDiff {
  additions: number;
  binary: boolean;
  deletions: number;
  hasHunks: boolean;
  lines: UnifiedDiffLine[];
}

const HUNK_HEADER_PATTERN = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;
const BINARY_DIFF_PATTERN = /^(?:Binary files .+ differ|GIT binary patch)$/m;

export function parseUnifiedDiff(diff: string): ParsedUnifiedDiff {
  const lines: UnifiedDiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let hasHunks = false;
  let inHunk = false;
  let oldLine: number | null = null;
  let newLine: number | null = null;

  const sourceLines = diff.split(/\r?\n/);
  for (const [index, text] of sourceLines.entries()) {
    if (index === sourceLines.length - 1 && text === "" && /\r?\n$/.test(diff)) {
      continue;
    }
    const hunk = text.match(HUNK_HEADER_PATTERN);
    if (hunk) {
      hasHunks = true;
      inHunk = true;
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[2], 10);
      lines.push({ kind: "hunk", oldLine: null, newLine: null, text });
      continue;
    }

    if (text.startsWith("diff --git ")) {
      inHunk = false;
      oldLine = null;
      newLine = null;
      lines.push({ kind: "header", oldLine: null, newLine: null, text });
      continue;
    }

    if (text === "\\ No newline at end of file") {
      lines.push({ kind: "no-newline", oldLine: null, newLine: null, text });
      continue;
    }

    if (!inHunk) {
      lines.push({ kind: "header", oldLine: null, newLine: null, text });
      continue;
    }

    if (text.startsWith("+")) {
      lines.push({ kind: "add", oldLine: null, newLine, text });
      additions += 1;
      newLine = newLine === null ? null : newLine + 1;
      continue;
    }

    if (text.startsWith("-")) {
      lines.push({ kind: "remove", oldLine, newLine: null, text });
      deletions += 1;
      oldLine = oldLine === null ? null : oldLine + 1;
      continue;
    }

    lines.push({ kind: "context", oldLine, newLine, text });
    oldLine = oldLine === null ? null : oldLine + 1;
    newLine = newLine === null ? null : newLine + 1;
  }

  return {
    additions,
    binary: BINARY_DIFF_PATTERN.test(diff),
    deletions,
    hasHunks,
    lines,
  };
}

function diffLineClassName(kind: UnifiedDiffLineKind) {
  if (kind === "add") return "bg-emerald-500/10 text-emerald-950 dark:text-emerald-100";
  if (kind === "remove") return "bg-red-500/10 text-red-950 dark:text-red-100";
  if (kind === "hunk") return "bg-cyan-500/10 text-cyan-800 dark:text-cyan-200";
  if (kind === "header") return "bg-muted/20 text-muted-foreground";
  if (kind === "no-newline") return "text-amber-700 dark:text-amber-300";
  return "text-foreground/82";
}

export function TranscriptUnifiedDiff({
  fileName,
  diff,
  truncated = false,
  originalBytes = null,
}: {
  fileName: string;
  diff: string;
  truncated?: boolean;
  originalBytes?: number | null;
}) {
  const parsed = parseUnifiedDiff(diff);

  return (
    <div
      className="motion-disclosure-enter mt-1.5 overflow-hidden rounded-lg border border-border/55 bg-background/70"
      data-transcript-unified-diff="true"
    >
      <div className="flex min-h-9 items-center gap-2 border-b border-border/55 bg-muted/15 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={fileName}>
          {fileName}
        </span>
        <span className="text-xs font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
          +{parsed.additions}
        </span>
        <span className="text-xs font-semibold tabular-nums text-red-600 dark:text-red-400">
          -{parsed.deletions}
        </span>
        <CopyText
          text={diff}
          ariaLabel={`Copy diff for ${fileName}`}
          title="Copy diff"
          className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted/50"
        >
          <Copy className="h-3.5 w-3.5" aria-hidden />
        </CopyText>
      </div>
      {truncated ? (
        <div className="border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200" role="status">
          Historical diff was truncated
          {originalBytes ? ` from ${originalBytes.toLocaleString()} bytes` : ""}. Raw details retain the truncation metadata.
        </div>
      ) : null}
      <div className="max-h-96 overflow-auto font-mono text-[11px] leading-5" role="region" aria-label={`Historical diff for ${fileName}`}>
        {parsed.lines.map((line, index) => (
          <div
            key={`${index}-${line.kind}`}
            className={cn("grid min-w-max grid-cols-[3.25rem_3.25rem_minmax(24rem,1fr)]", diffLineClassName(line.kind))}
            data-diff-line-kind={line.kind}
          >
            <span className="select-none border-r border-border/30 px-2 text-right tabular-nums text-muted-foreground/70">
              {line.oldLine ?? ""}
            </span>
            <span className="select-none border-r border-border/30 px-2 text-right tabular-nums text-muted-foreground/70">
              {line.newLine ?? ""}
            </span>
            <span className="whitespace-pre px-2">{line.text || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
