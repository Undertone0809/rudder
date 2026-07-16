import { describe, expect, it } from "vitest";
import {
  createDesktopBugReportUrl,
  createDesktopSupportMailtoUrl,
  DESKTOP_BUG_REPORT_URL,
  DESKTOP_FEEDBACK_EMAIL,
  MAX_DESKTOP_SUPPORT_MAILTO_LENGTH,
} from "./desktop-support-mail.js";

describe("desktop support mail", () => {
  it("keeps generic feedback compatible with the About page", () => {
    expect(createDesktopSupportMailtoUrl({
      version: "0.4.6",
      platform: "darwin",
      arch: "arm64",
    })).toBe(`mailto:${DESKTOP_FEEDBACK_EMAIL}?subject=Rudder%20feedback%20(0.4.6)`);
  });

  it("builds a bounded startup draft from the safe failure view", () => {
    const url = createDesktopSupportMailtoUrl({
      version: "0.4.6\r\nBcc: attacker@example.com",
      platform: "darwin",
      arch: "arm64",
      profile: "prod_local&attach=/tmp/private",
      instance: "default",
      failure: {
        id: "failure-123",
        occurredAt: "2026-07-15T10:00:00.000Z",
        stage: "database",
        attempt: 2,
        category: "migration",
        summary: "The local database could not finish its migration.",
      },
    });
    const parsed = new URL(url);
    const body = parsed.searchParams.get("body") ?? "";

    expect(parsed.protocol).toBe("mailto:");
    expect(parsed.pathname).toBe(DESKTOP_FEEDBACK_EMAIL);
    expect(parsed.searchParams.get("subject")).toContain("Rudder startup support");
    expect(parsed.searchParams.has("bcc")).toBe(false);
    expect(parsed.searchParams.has("cc")).toBe(false);
    expect(parsed.searchParams.has("attach")).toBe(false);
    expect(body).toContain("Failure ID: failure-123");
    expect(body).toContain("What were you trying to do?");
    expect(body).toContain("What changed before this started?");
    expect(body).toContain("Did Try again change the result?");
    expect(body).toContain("Impact or workaround:");
    expect(body).toContain("Safe diagnostic (added by Rudder)");
    expect(body).toContain("Failure summary: The local database could not finish its migration.");
    expect(body).toContain("Do not attach .env");
    expect(url).not.toContain("+");
    expect(url).toContain("%20");
    expect(url).toContain("%0A");
    expect(url.length).toBeLessThanOrEqual(MAX_DESKTOP_SUPPORT_MAILTO_LENGTH);
  });

  it("keeps the bug report destination fixed to the repository template", () => {
    const parsed = new URL(DESKTOP_BUG_REPORT_URL);

    expect(parsed.origin).toBe("https://github.com");
    expect(parsed.pathname).toBe("/Undertone0809/rudder/issues/new");
    expect(parsed.searchParams.get("template")).toBe("bug_report.yml");
  });

  it("prefills rollback email and public GitHub drafts with the same safe failure context", () => {
    const input = {
      version: "0.4.6",
      failedVersion: "0.4.7",
      restoredVersion: "0.4.6",
      platform: "darwin",
      arch: "arm64",
      profile: "prod_local",
      instance: "default",
      context: "rollback" as const,
      failure: {
        id: "failure-rollback",
        occurredAt: "2026-07-16T10:00:00.000Z",
        stage: "database",
        attempt: 1,
        category: "database" as const,
        summary: "The local database did not start cleanly.",
      },
    };

    const mail = createDesktopSupportMailtoUrl(input);
    const issue = createDesktopBugReportUrl(input);
    expect(new URL(mail).searchParams.get("body")).toContain("Failure ID: failure-rollback");
    expect(new URL(mail).searchParams.get("body")).toContain("Failed update: 0.4.7");
    expect(new URL(issue).pathname).toBe("/Undertone0809/rudder/issues/new");
    expect(new URL(issue).searchParams.get("title")).toContain("0.4.7 failed and rolled back");
    expect(new URL(issue).searchParams.get("body")).toContain("Failure ID: failure-rollback");
    expect(issue).not.toContain("+");
  });

  it("bounds all renderer-adjacent metadata before encoding", () => {
    const url = createDesktopSupportMailtoUrl({
      version: "v".repeat(4_000),
      platform: "p".repeat(4_000),
      arch: "a".repeat(4_000),
      profile: "x".repeat(4_000),
      instance: "y".repeat(4_000),
      failure: {
        id: "failure-789",
        occurredAt: "2026-07-15T10:00:00.000Z",
        stage: "database",
        attempt: 1,
        category: "database",
        summary: "The local database did not start cleanly.",
      },
    });

    expect(url.length).toBeLessThanOrEqual(MAX_DESKTOP_SUPPORT_MAILTO_LENGTH);
  });
});
