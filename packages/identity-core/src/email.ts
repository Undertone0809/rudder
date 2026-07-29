const MAX_EMAIL_LENGTH = 254;

/**
 * Canonicalizes an email only after an upstream provider has proved ownership.
 *
 * Rudder deliberately does not implement provider-specific dot or plus aliases:
 * those rules are not universal and would merge distinct mailboxes.
 */
export function normalizeVerifiedEmail(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_EMAIL_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error("Invalid verified email");
  }

  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1 || normalized.indexOf("@") !== at) {
    throw new Error("Invalid verified email");
  }

  return normalized;
}

export function maskEmail(value: string): string {
  const normalized = normalizeVerifiedEmail(value);
  const [local, domain] = normalized.split("@");
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${local.length > 2 ? "•••" : "•"}@${domain}`;
}
