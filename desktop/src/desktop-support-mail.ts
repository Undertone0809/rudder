import type { DesktopStartupFailureView } from "./desktop-startup-failure.js";

export const DESKTOP_FEEDBACK_EMAIL = "zeeland4work@gmail.com";
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
    "Rudder could not start. Please add the context below before sending:",
    "",
    "What were you trying to do?",
    "[Add context here]",
    "",
    "What changed before this started?",
    "[Add context here]",
    "",
    "Diagnostic summary",
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
    "Please do not attach .env, config.json, databases, API keys, credentials, or private workspace files.",
  ].join("\n");

  return createMailto(`Rudder startup support (${version})`, body);
}
