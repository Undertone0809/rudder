import { describe, expect, it } from "vitest";
import type { SupabaseRootIdentityConfig } from "./config.js";
import { CapturedMailAdapter } from "./mail.js";
import type {
  RootIdentityCookieMutation,
  RootIdentityRequestContext,
} from "./root-identity-adapter.js";
import { createRootIdentityFixture } from "./root-identity-fixture.js";

const config: Extract<SupabaseRootIdentityConfig, { environment: "fixture" }> = {
  environment: "fixture",
  callbackUrl: "http://127.0.0.1:3200/auth/callback",
  passwordResetUrl: "http://127.0.0.1:3200/reset-password",
  cookieName: "rudder_account",
  cookieSecure: false,
};

function context(cookie?: string) {
  const written: RootIdentityCookieMutation[] = [];
  const value: RootIdentityRequestContext = {
    requestHeaders: new Headers(cookie ? { cookie } : undefined),
    setCookies: (cookies) => {
      written.push(...cookies);
    },
  };
  return {
    value,
    written,
    cookie: () => written
      .filter(({ value: cookieValue, options }) => cookieValue && options.maxAge !== 0)
      .map(({ name, value: cookieValue }) =>
        `${name}=${encodeURIComponent(cookieValue)}`
      )
      .join("; "),
  };
}

describe("in-process root identity fixture", () => {
  it("runs deterministic OAuth, captured OTP, password, recovery, and session revocation", async () => {
    const mail = new CapturedMailAdapter();
    const adapter = createRootIdentityFixture(config, mail);

    const oauth = await adapter.beginOAuth(context().value, {
      provider: "google",
      nextPath: "/account",
    });
    expect(oauth.redirectUrl).toBe(
      "http://127.0.0.1:3200/auth/callback?code=fixture-google&next=%2Faccount",
    );
    const oauthContext = context();
    await expect(adapter.completePkceCallback(oauthContext.value, {
      code: "fixture-google",
    })).resolves.toMatchObject({
      email: "google.fixture@rudder.test",
      emailVerified: true,
    });
    await expect(
      adapter.requireActivePrincipal(context(oauthContext.cookie()).value),
    ).resolves.toMatchObject({ email: "google.fixture@rudder.test" });

    const email = "fixture-user@example.com";
    await adapter.sendEmailOtp(context().value, { email });
    expect(mail.messages.at(-1)).toMatchObject({ to: email, category: "sign-in" });
    const otpContext = context();
    await expect(adapter.verifyEmailOtp(otpContext.value, {
      email,
      token: "123456",
      purpose: "sign-in",
    })).resolves.toMatchObject({ email });

    await expect(adapter.signUpWithPassword(context().value, {
      email,
      password: "fixture-original-password",
    })).resolves.toMatchObject({ verificationRequired: true });
    await adapter.verifyEmailOtp(context().value, {
      email,
      token: "234567",
      purpose: "email-verification",
    });
    const passwordContext = context();
    await adapter.signInWithPassword(passwordContext.value, {
      email,
      password: "fixture-original-password",
    });

    await adapter.requestPasswordReset(context().value, { email });
    const resetMessage = mail.messages.findLast(({ category }) =>
      category === "password-reset"
    );
    expect(resetMessage?.text).toContain(
      "/reset-password?token_hash=345678&type=recovery",
    );
    const recoveryContext = context();
    await adapter.completePasswordRecovery(recoveryContext.value, {
      tokenHash: "345678",
    });
    await adapter.updateRecoveredPassword(
      context(recoveryContext.cookie()).value,
      { newPassword: "fixture-replacement-password" },
      async () => undefined,
    );
    await expect(
      adapter.requireActivePrincipal(context(passwordContext.cookie()).value),
    ).rejects.toMatchObject({ code: "session_revoked" });
    await expect(adapter.signInWithPassword(context().value, {
      email,
      password: "fixture-replacement-password",
    })).resolves.toMatchObject({ email });
  });

  it("keeps current, others, and global sign-out scopes independent", async () => {
    const adapter = createRootIdentityFixture(config, new CapturedMailAdapter());
    const email = "scoped-session@example.com";
    await adapter.signUpWithPassword(context().value, {
      email,
      password: "fixture-scoped-password",
    });
    await adapter.verifyEmailOtp(context().value, {
      email,
      token: "234567",
      purpose: "email-verification",
    });

    const first = context();
    const second = context();
    await adapter.signInWithPassword(first.value, {
      email,
      password: "fixture-scoped-password",
    });
    await adapter.signInWithPassword(second.value, {
      email,
      password: "fixture-scoped-password",
    });
    await adapter.signOut(context(first.cookie()).value, "current");
    await expect(
      adapter.requireActivePrincipal(context(first.cookie()).value),
    ).rejects.toMatchObject({ code: "session_revoked" });
    await expect(
      adapter.requireActivePrincipal(context(second.cookie()).value),
    ).resolves.toMatchObject({ email });

    const third = context();
    await adapter.signInWithPassword(third.value, {
      email,
      password: "fixture-scoped-password",
    });
    await adapter.signOut(context(second.cookie()).value, "others");
    await expect(
      adapter.requireActivePrincipal(context(second.cookie()).value),
    ).resolves.toMatchObject({ email });
    await expect(
      adapter.requireActivePrincipal(context(third.cookie()).value),
    ).rejects.toMatchObject({ code: "session_revoked" });

    const fourth = context();
    await adapter.signInWithPassword(fourth.value, {
      email,
      password: "fixture-scoped-password",
    });
    await adapter.signOut(context(second.cookie()).value, "global");
    await expect(
      adapter.requireActivePrincipal(context(second.cookie()).value),
    ).rejects.toMatchObject({ code: "session_revoked" });
    await expect(
      adapter.requireActivePrincipal(context(fourth.cookie()).value),
    ).rejects.toMatchObject({ code: "session_revoked" });
  });
});
