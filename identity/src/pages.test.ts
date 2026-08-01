import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { identityClientScript } from "./client-script.js";
import {
  accountPage,
  deviceApprovalPage,
  homePage,
  passwordRecoveryPage,
  privacyPage,
  termsPage,
} from "./pages.js";

describe("Identity public pages", () => {
  it("offers all four login methods and disables unconfigured providers", () => {
    const html = homePage({ google: true, github: false });
    expect(html).toContain("Continue with Google");
    expect(html).toContain('data-social="github" disabled');
    expect(html).toContain("Continue with email code");
    expect(html).toContain('pattern="[0-9]{6,8}" maxlength="8"');
    expect(html).toContain('placeholder="00000000"');
    expect(html).toContain("Sign in with password");
    expect(html).toContain("Create account with password");
    expect(html).toContain("Reset password");
    expect(html).toContain('class="auth-card"');
    expect(html).toContain('<img src="/rudder-logo.png" alt="">');
    expect(html).toContain('<link rel="icon" href="/favicon.ico"');
    expect(html).toContain("Welcome to Rudder");
    expect(html).toContain("Signing in connects your identity and devices");
    expect(html).toContain('id="change-email"');
    expect(html).toContain("[hidden] { display: none !important; }");
    expect(html).not.toContain("background-image");
    expect(html).not.toContain("font-family: Inter");
  });

  it("offers password, scoped web-session controls, and separate device controls", () => {
    const html = accountPage("owner@example.com");
    expect(html).toContain("Send verification code");
    expect(html).toContain('pattern="[0-9]{6,8}" maxlength="8"');
    expect(html).toContain("Set or change password");
    expect(html).toContain('name="revokeOthers"');
    expect(html).toContain("leave Rudder Desktop access unchanged");
    expect(html).toContain('data-sign-out-scope="current"');
    expect(html).toContain('data-sign-out-scope="others"');
    expect(html).toContain('data-sign-out-scope="global"');
    expect(html).toContain("Web sessions");
    expect(html).toContain("Devices");
    expect(html).not.toContain("web-session-list");
    expect(html).not.toContain("revoke-other-web-sessions");
  });

  it("renders a recovery-only page with explicit browser and Local session revocation", () => {
    const html = passwordRecoveryPage("owner@example.com");
    expect(html).toContain('id="recovery-password-form"');
    expect(html).toContain("signs out every browser");
    expect(html).toContain("revokes Rudder Desktop cloud access");
    expect(html).toContain("local expiry or next identity sync");
    expect(html).not.toContain('name="email"');
  });

  it("renders device approval as one compact, branded decision surface", () => {
    const html = deviceApprovalPage("ABCD-1234");
    expect(html).toContain('class="auth-card device-card"');
    expect(html).toContain('<img src="/rudder-logo.png" alt="">');
    expect(html).toContain('id="device-user-code">ABCD-1234</strong>');
    expect(html).toContain('id="device-decision"');
    expect(html).toContain(
      'id="device-result" role="status" aria-live="polite" aria-atomic="true" hidden',
    );
    expect(html).toContain('id="return-to-rudder"');
    expect(html).toContain("Only approve if this code matches");
    expect(html).not.toContain("<section>\n       <button");
    expect(deviceApprovalPage("SAFE<script>")).toContain("SAFE&lt;script&gt;");
  });

  it("uses only the provider-neutral root-auth facade for browser authentication", () => {
    expect(identityClientScript).toContain('request("/api/root-auth/oauth"');
    expect(identityClientScript).toContain("location.assign(result.redirectUrl)");
    expect(identityClientScript).toContain('request("/api/root-auth/email-otp/send"');
    expect(identityClientScript).toContain('request("/api/root-auth/email-otp/verify"');
    expect(identityClientScript).toContain('request("/api/root-auth/password/sign-in"');
    expect(identityClientScript).toContain('request("/api/root-auth/password/sign-up"');
    expect(identityClientScript).toContain('request("/api/root-auth/password/reset/request"');
    expect(identityClientScript).toContain('request("/api/root-auth/password/reset/confirm"');
    expect(identityClientScript).toContain(
      'request("/api/root-auth/password/recovery/complete"',
    );
    expect(identityClientScript).toContain('request("/api/root-auth/password/reauthenticate"');
    expect(identityClientScript).toContain('request("/api/root-auth/password/update"');
    expect(identityClientScript).toContain('request("/api/root-auth/sign-out"');
    expect(identityClientScript).toContain('candidate.searchParams.get("login_intent")');
    expect(identityClientScript).toContain('request("/api/desktop/sign-in-intent/resolve"');
    expect(identityClientScript).toContain(
      'document.querySelector(\'[data-social="\' + requestedLoginMethod + \'"]\')?.click?.()',
    );
    expect(identityClientScript).toContain('requestedLoginMethod === "password_reset"');
    expect(identityClientScript).not.toContain("/api/auth/");
    expect(identityClientScript).not.toContain("/api/account/web-sessions");
  });

  it("sends only supported Supabase sign-out scopes through the root-auth facade", async () => {
    const handlers = new Map<string, () => Promise<void>>();
    const requests: Array<{ path: string; body: Record<string, string> }> = [];
    let assigned: string | undefined;
    const status = {
      textContent: "",
      dataset: {} as Record<string, string>,
      style: { color: "" },
    };
    const buttons = ["current", "others", "global"].map((scope) => ({
      dataset: { signOutScope: scope, loading: "false" },
      disabled: false,
      setAttribute() {},
      addEventListener: (_name: string, handler: () => Promise<void>) => {
        handlers.set(scope, handler);
      },
    }));

    runInNewContext(identityClientScript, {
      URL,
      URLSearchParams,
      location: {
        origin: "https://accounts.rudderhq.dev",
        search: "",
        assign: (value: string) => {
          assigned = value;
        },
      },
      document: {
        querySelector: (selector: string) => (selector === "#auth-status" ? status : null),
        querySelectorAll: (selector: string) =>
          selector === "[data-sign-out-scope]" ? buttons : [],
      },
      fetch: async (path: string, init: { body: string }) => {
        requests.push({ path, body: JSON.parse(init.body) as Record<string, string> });
        return { ok: true, json: async () => ({}) };
      },
    });

    await handlers.get("others")!();
    expect(requests).toEqual([
      { path: "/api/root-auth/sign-out", body: { scope: "others" } },
    ]);
    expect(assigned).toBeUndefined();

    await handlers.get("global")!();
    expect(requests.at(-1)).toEqual({
      path: "/api/root-auth/sign-out",
      body: { scope: "global" },
    });
    expect(assigned).toBe("/");
  });

  it("rejects encoded backslash redirects in the browser client", async () => {
    let passwordHandler: ((event: { preventDefault(): void; currentTarget: object }) => Promise<void>) | undefined;
    let assigned: string | undefined;
    const status = { textContent: "", style: { color: "" } };
    const passwordForm = {
      addEventListener: (
        _name: string,
        handler: (event: { preventDefault(): void; currentTarget: object }) => Promise<void>,
      ) => {
        passwordHandler = handler;
      },
    };
    runInNewContext(identityClientScript, {
      URL,
      URLSearchParams,
      location: {
        origin: "https://accounts.rudderhq.dev",
        search: "?next=/%5cevil.example",
        assign: (value: string) => {
          assigned = value;
        },
      },
      document: {
        querySelector: (selector: string) => {
          if (selector === "#auth-status") return status;
          if (selector === "#password-form") return passwordForm;
          return null;
        },
        querySelectorAll: () => [],
      },
      FormData: class {
        get(key: string) {
          return key === "email" ? "owner@example.com" : "password";
        }
      },
      fetch: async () => ({ ok: true, json: async () => ({}) }),
    });
    expect(passwordHandler).toBeTypeOf("function");
    await passwordHandler!({ preventDefault() {}, currentTarget: {} });
    expect(assigned).toBe("/");
  });

  it("preserves a production-shaped Desktop PKCE continuation while stripping login hints", async () => {
    const requests: Array<{ path: string; body: Record<string, string> }> = [];
    let clickHandler: (() => Promise<void>) | undefined;
    let clickPromise: Promise<void> | undefined;
    const status = {
      textContent: "",
      dataset: {} as Record<string, string>,
      style: { color: "" },
    };
    const googleButton = {
      dataset: { social: "google", loading: "false" },
      disabled: false,
      setAttribute() {},
      addEventListener: (_name: string, handler: () => Promise<void>) => {
        clickHandler = handler;
      },
      click: () => {
        clickPromise = clickHandler?.();
      },
    };
    const intent = "opaque_intent_with_enough_random_material";
    const desktopNext = `/api/desktop/authorize?client_id=rudder-desktop&response_type=code&redirect_uri=${
      encodeURIComponent("http://127.0.0.1:45831/callback")
    }&code_challenge=${"a".repeat(43)}&state=state-with-enough-entropy&login_intent=${intent}`;

    await runInNewContext(identityClientScript, {
      URL,
      URLSearchParams,
      location: {
        origin: "https://accounts.rudderhq.dev",
        search: `?next=${encodeURIComponent(desktopNext)}`,
        assign() {},
      },
      document: {
        querySelector: (selector: string) => {
          if (selector === "#auth-status") return status;
          if (selector === '[data-social="google"]') return googleButton;
          return null;
        },
        querySelectorAll: (selector: string) =>
          selector === "[data-social]" ? [googleButton] : [],
      },
      fetch: async (path: string, init: { body: string }) => {
        requests.push({ path, body: JSON.parse(init.body) as Record<string, string> });
        return path === "/api/desktop/sign-in-intent/resolve"
          ? { ok: true, json: async () => ({ method: "google" }) }
          : { ok: true, json: async () => ({ redirectUrl: "https://accounts.google.com/" }) };
      },
    });

    await clickPromise;
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
      path: "/api/desktop/sign-in-intent/resolve",
      body: {
        client_id: "rudder-desktop",
        code_challenge: "a".repeat(43),
        redirect_uri: "http://127.0.0.1:45831/callback",
        state: "state-with-enough-entropy",
        intent,
      },
    });
    expect(requests[1]?.path).toBe("/api/root-auth/oauth");
    expect(requests[1]?.body.provider).toBe("google");
    const nextPath = requests[1]?.body.nextPath;
    expect(nextPath).toContain("redirect_uri=http%3A%2F%2F127.0.0.1%3A45831%2Fcallback");
    expect(nextPath).not.toContain("login_intent");
  });

  it("keeps the email step visible when sending a code fails", async () => {
    let otpHandler: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
    const status = { textContent: "", dataset: {} as Record<string, string>, style: { color: "" } };
    const submit = {
      dataset: {} as Record<string, string>,
      disabled: false,
      setAttribute() {},
    };
    const emailInput = { focus() {} };
    const otpInput = { focus() {} };
    const otpForm = {
      hidden: false,
      addEventListener: (
        _name: string,
        handler: (event: { preventDefault(): void }) => Promise<void>,
      ) => {
        otpHandler = handler;
      },
      querySelector: (selector: string) =>
        selector === 'button[type="submit"]' ? submit : emailInput,
    };
    const verifyForm = {
      hidden: true,
      querySelector: () => otpInput,
      addEventListener() {},
    };
    runInNewContext(identityClientScript, {
      URL,
      URLSearchParams,
      location: {
        origin: "https://accounts.rudderhq.dev",
        search: "",
        assign() {},
      },
      document: {
        querySelector: (selector: string) => {
          if (selector === "#auth-status") return status;
          if (selector === "#otp-form") return otpForm;
          if (selector === "#otp-verify-form") return verifyForm;
          return null;
        },
        querySelectorAll: () => [],
      },
      FormData: class {
        get() {
          return "owner@example.com";
        }
      },
      fetch: async () => ({
        ok: false,
        json: async () => ({ message: "Mail transport unavailable" }),
      }),
    });

    expect(otpHandler).toBeTypeOf("function");
    await otpHandler!({ preventDefault() {} });
    expect(otpForm.hidden).toBe(false);
    expect(verifyForm.hidden).toBe(true);
    expect(submit.disabled).toBe(false);
    expect(status.dataset.state).toBe("error");
    expect(status.textContent).toBe("Mail transport unavailable");
  });

  it("publishes the Local privacy boundary and deletion contact", () => {
    const privacy = privacyPage("support@rudderhq.dev");
    expect(privacy).toContain("Signing in does not upload");
    expect(privacy).toContain("request access, correction, export, or deletion");
    expect(privacy).toContain("revoke browser sessions and registered devices");
    expect(privacy).not.toContain("revoke sessions and linked login methods");
    expect(termsPage("support@rudderhq.dev")).toContain("account deletion requests");
  });
});
