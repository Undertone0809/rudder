import type { DesktopStartupFailureView } from "./desktop-startup-failure.js";

export const DESKTOP_FEEDBACK_EMAIL = "zeeland4work@gmail.com";
export const DESKTOP_BUG_REPORT_URL = "https://github.com/Undertone0809/rudder/issues/new?template=bug_report.yml";
export const MAX_DESKTOP_SUPPORT_MAILTO_LENGTH = 1_900;

function cleanMailField(value: string | null | undefined, maxLength: number): string | null {
  const cleaned = value
    ?.replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

function createMailto(subject: string, body?: string): string {
  const params = new URLSearchParams({ subject });
  if (body) params.set("body", body);
  const url = `mailto:${DESKTOP_FEEDBACK_EMAIL}?${params.toString()}`;
  if (url.length > MAX_DESKTOP_SUPPORT_MAILTO_LENGTH) {
    throw new Error("The support email draft exceeds the safe mailto length.");
  }
  return url;
}

export function createDesktopSupportMailtoUrl(input: {
  version: string;
  platform: string;
  arch: string;
  failure?: DesktopStartupFailureView | null;
  profile?: string | null;
  instance?: string | null;
}): string {
  const version = cleanMailField(input.version, 80) ?? "unknown";
  if (!input.failure) {
    return createMailto(`Rudder feedback (${version})`);
  }

  const failure = input.failure;
  const profile = cleanMailField(input.profile, 80) ?? "unknown";
  const instance = cleanMailField(input.instance, 80) ?? "unknown";
  const platform = cleanMailField(input.platform, 40) ?? "unknown";
  const arch = cleanMailField(input.arch, 40) ?? "unknown";
  const body = [
    "Hi,",
    "",
    "Rudder could not start. Please replace the bracketed prompts before sending.",
    "",
    "Report",
    "Summary: [What broke, and which workflow is blocked?]",
    "",
    "Steps to reproduce:",
    "1. [First action]",
    "2. [Next action]",
    "3. [What happened]",
    "",
    "Actual result: [What did you see? Include the exact short error if useful.]",
    "Expected result: [What should have happened?]",
    "When did this begin? [Approximate time or first affected version]",
    "What changed beforehand? [Install, update, configuration, or system change]",
    "Did Try again change the result? [Yes/no and what changed]",
    "Impact and workaround: [Who is blocked? Is there a workaround?]",
    "Evidence: [Add a screenshot or a few relevant log lines after removing private data.]",
    "Environment details: [OS version and how Rudder was installed or launched.]",
    "",
    "Safe diagnostic summary (added by Rudder)",
    `Failure ID: ${failure.id}`,
    `Occurred at: ${failure.occurredAt}`,
    `Rudder version: ${version}`,
    `System: ${platform} / ${arch}`,
    `Stage: ${failure.stage}`,
    `Attempt: ${failure.attempt}`,
    `Category: ${failure.category}`,
    `Profile: ${profile}`,
    `Instance: ${instance}`,
    "",
    "Before sending, remove API keys, tokens, cookies, passwords, private URLs, prompts, command output, and private paths. Do not attach .env, config.json, databases, credentials, or private workspace files.",
  ].join("\n");

  return createMailto(`Rudder startup support (${version})`, body);
}
