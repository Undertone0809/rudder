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
});
