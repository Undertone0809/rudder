export type IdentityMail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  category: "sign-in" | "email-verification" | "forget-password" | "change-email" | "password-reset";
};

export interface IdentityMailAdapter {
  send(message: IdentityMail): Promise<void>;
}

export class CapturedMailAdapter implements IdentityMailAdapter {
  readonly messages: IdentityMail[] = [];

  async send(message: IdentityMail): Promise<void> {
    this.messages.push(structuredClone(message));
  }
}

export class ResendMailAdapter implements IdentityMailAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: IdentityMail): Promise<void> {
    const response = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
        tags: [{ name: "category", value: message.category }],
      }),
    });
    if (!response.ok) {
      throw new Error(`Resend rejected Identity email (${response.status})`);
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

export function otpMail(input: {
  to: string;
  otp: string;
  type: "sign-in" | "email-verification" | "forget-password" | "change-email";
}): IdentityMail {
  const purpose = input.type === "forget-password"
    ? "reset your Rudder Account password"
    : input.type === "change-email"
      ? "change your Rudder Account email"
      : "sign in to your Rudder Account";
  const code = escapeHtml(input.otp);
  return {
    to: input.to,
    subject: "Your Rudder Account verification code",
    text: `Use ${input.otp} to ${purpose}. This code expires in 10 minutes. If you did not request it, ignore this email.`,
    html: `<p>Use <strong>${code}</strong> to ${purpose}.</p><p>This code expires in 10 minutes. If you did not request it, ignore this email.</p>`,
    category: input.type,
  };
}

export function passwordResetMail(input: { to: string; url: string; code?: string }): IdentityMail {
  const url = escapeHtml(input.url);
  const code = input.code ? escapeHtml(input.code) : null;
  const codeText = input.code
    ? `Use ${input.code} to reset your Rudder Account password.\n\n`
    : "";
  const codeHtml = code
    ? `<p>Use <strong>${code}</strong> to reset your Rudder Account password.</p>`
    : "";
  return {
    to: input.to,
    subject: "Reset your Rudder Account password",
    text: `${codeText}Reset your Rudder Account password: ${input.url}\n\nIf you did not request it, ignore this email.`,
    html: `${codeHtml}<p><a href="${url}">Reset your Rudder Account password</a></p><p>If you did not request it, ignore this email.</p>`,
    category: "password-reset",
  };
}
