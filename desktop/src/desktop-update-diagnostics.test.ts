import { describe, expect, it } from "vitest";
import {
  appendBoundedDesktopUpdateOutput,
  summarizeDesktopUpdateChildOutput,
} from "./desktop-update-diagnostics";

describe("desktop update diagnostics", () => {
  it("keeps the latest child-process output within a bounded buffer", () => {
    expect(appendBoundedDesktopUpdateOutput("abcdef", "ghij", 6)).toBe("efghij");
  });

  it("summarizes stderr before stdout and strips terminal escapes", () => {
    expect(
      summarizeDesktopUpdateChildOutput({
        stdout: "stdout fallback\n",
        stderr: "\u001b[31mNo checksummed Rudder Desktop asset found\u001b[39m\n",
      }),
    ).toBe("No checksummed Rudder Desktop asset found");
  });

  it("ignores structured progress JSON when using stdout as a fallback", () => {
    expect(
      summarizeDesktopUpdateChildOutput({
        stdout: [
          JSON.stringify({
            source: "rudder-desktop-update",
            phase: "failed",
            message: "Resolving Desktop release failed.",
            at: "2026-06-08T00:00:00.000Z",
          }),
          "Unable to resolve Rudder Desktop release tag",
        ].join("\n"),
      }),
    ).toBe("Unable to resolve Rudder Desktop release tag");
  });

  it("filters the Node SQLite warning and keeps the actionable stderr error", () => {
    expect(
      summarizeDesktopUpdateChildOutput({
        stderr: [
          "(node:67685) ExperimentalWarning: SQLite is an experimental feature and might change at any time",
          "(Use `Rudder --trace-warnings ...` to show where the warning was created)",
          "Rudder Desktop has 1 running run. Wait for running work, then retry.",
        ].join("\n"),
      }),
    ).toBe("Rudder Desktop has 1 running run. Wait for running work, then retry.");
  });

  it("falls back to actionable stdout when stderr contains only the Node SQLite warning", () => {
    expect(
      summarizeDesktopUpdateChildOutput({
        stderr: [
          "(node:67685) ExperimentalWarning: SQLite is an experimental feature and might change at any time",
          "(Use `Rudder --trace-warnings ...` to show where the warning was created)",
        ].join("\n"),
        stdout: "Unable to replace Rudder Desktop\n",
      }),
    ).toBe("Unable to replace Rudder Desktop");
  });
});
