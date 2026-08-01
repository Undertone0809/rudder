import { describe, expect, it, vi } from "vitest";
import {
  CapturedMailAdapter,
  otpMail,
  passwordResetMail,
  ResendMailAdapter,
} from "./mail.js";

describe("Identity mail adapters", () => {
  it("captures deterministic OTP mail locally", async () => {
    const adapter = new CapturedMailAdapter();
    await adapter.send(otpMail({ to: "a@example.com", otp: "123456", type: "sign-in" }));
    expect(adapter.messages).toHaveLength(1);
    expect(adapter.messages[0]?.text).toContain("123456");
  });

  it("includes the native reset code when one is available", () => {
    const message = passwordResetMail({
      to: "a@example.com",
      url: "http://127.0.0.1:3200/reset-password?token_hash=345678&type=recovery",
      code: "345678",
    });
    expect(message.text).toContain("Use 345678 to reset your Rudder Account password.");
    expect(message.html).toContain("<strong>345678</strong>");
  });

  it("uses the Resend HTTPS API without exposing the API key in the body", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ id: "mail-id" }), { status: 200 });
    });
    const adapter = new ResendMailAdapter("secret-key", "Rudder <account@example.com>", fetchImpl);
    await adapter.send(otpMail({ to: "a@example.com", otp: "123456", type: "sign-in" }));
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(capturedInit?.headers).toMatchObject({ authorization: "Bearer secret-key" });
    expect(capturedInit?.body).not.toContain("secret-key");
  });
});
