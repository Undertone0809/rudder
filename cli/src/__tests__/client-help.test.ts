import type { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../program.js";

function commandHelp(path: string[]): string {
  let command: Command = createProgram();
  for (const part of path) {
    const child = command.commands.find((candidate) => candidate.name() === part);
    if (!child) {
      throw new Error(`Missing command in help test: ${path.join(" ")}`);
    }
    command = child;
  }
  let output = "";
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const log = vi.spyOn(console, "log").mockImplementation((...args) => {
    output += `${args.map(String).join(" ")}\n`;
  });
  try {
    command.outputHelp();
  } finally {
    stdout.mockRestore();
    log.mockRestore();
  }
  return output;
}

function expectHelpNotes(path: string[], snippets: string[]): void {
  const help = commandHelp(path);
  expect(help).toContain("Examples:");
  expect(help).toContain("Cautions:");
  for (const snippet of snippets) {
    expect(help).toContain(snippet);
  }
}

describe("client command help examples and cautions", () => {
  it("documents issue comment/done/review body files, images, and review decisions", () => {
    expectHelpNotes(["issue", "comment"], [
      "Progress update with attached screenshot evidence",
      "--body-file",
      "--image",
      "old --body option is intentionally rejected",
      "Attach local visual evidence with --image",
    ]);
    expectHelpNotes(["issue", "done"], [
      "Close out with validation summary and visual evidence",
      "--comment-file",
      "--image",
      "run ownership conflict",
    ]);
    expectHelpNotes(["issue", "review"], [
      "Return implementation work with durable review feedback",
      "--decision request_changes",
      "Free-form comments are not durable review decisions",
    ]);
  });

  it("documents runs list/errors/transcript bounded debug workflow", () => {
    expectHelpNotes(["runs", "list"], [
      "Find recent failures for one agent before opening transcripts",
      "--agent-id",
      "--status failed",
      "Filter first",
      "Use runs errors or runs transcript",
    ]);
    expectHelpNotes(["runs", "errors"], [
      "Start failed-run investigation with error summaries",
      "--max-chars",
      "Start here for failed runs",
    ]);
    expectHelpNotes(["runs", "transcript"], [
      "Inspect the neighborhood around a failing step",
      "--around-error",
      "--include-output",
      "Human output is compact and clipped",
    ]);
  });

  it("documents agent skill additive enable versus replacement sync", () => {
    expectHelpNotes(["agent", "skills", "enable"], [
      "Add skills while preserving the agent's existing enabled set",
      "This is additive",
      "preserves existing enabled optional skills",
    ]);
    expectHelpNotes(["agent", "skills", "sync"], [
      "Replace the optional enabled set with an explicitly preserved CSV",
      "Sync replaces the full optional enabled-skill set",
      "Preserve every existing desired skill",
    ]);
  });

  it("documents library file ref/put path and body handling", () => {
    expectHelpNotes(["library", "file", "ref"], [
      "Return the renderable Markdown link for a known Library file",
      "Library-relative path",
      "markdownLink",
    ]);
    expectHelpNotes(["library", "file", "put"], [
      "Upload a durable Markdown artifact from a local file",
      "--body-file",
      "old --body option is intentionally rejected",
    ]);
  });

  it("documents automation run target and retry cautions", () => {
    expectHelpNotes(["automation", "run"], [
      "Run a verified automation manually with an explicit payload",
      "--idempotency-key",
      "Confirm the automation and trigger target",
    ]);
  });

  it("documents approval decision and comment flag differences", () => {
    expectHelpNotes(["approval", "approve"], [
      "Read the approval payload before deciding",
      "--decision-note",
      "approval approve/reject use --decision-note",
    ]);
    expectHelpNotes(["approval", "comment"], [
      "Add a longer Markdown discussion note without deciding",
      "--body-file",
      "Comments do not approve or reject",
    ]);
  });
});
