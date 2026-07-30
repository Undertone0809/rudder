import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { identityClientScript } from "./client-script.js";
import { accountPage, homePage, privacyPage, termsPage } from "./pages.js";

describe("Identity public pages", () => {
  it("offers all four login methods and disables unconfigured providers", () => {
    const html = homePage({ google: true, github: false });
    expect(html).toContain("Continue with Google");
    expect(html).toContain('data-social="github" disabled');
    expect(html).toContain("Continue with email code");
    expect(html).toContain("Sign in with password");
    expect(html).toContain("Create account with password");
    expect(html).toContain("Reset password");
    expect(html).toContain('class="auth-card"');
    expect(html).toContain("Welcome to Rudder");
    expect(html).toContain("Signing in connects your identity and devices");
    expect(html).toContain('id="change-email"');
    expect(html).toContain("[hidden] { display: none !important; }");
    expect(html).not.toContain("background-image");
    expect(html).not.toContain("font-family: Inter");
  });

  it("offers password, separate web-session/device controls, and explicit sign out", () => {
    const html = accountPage("owner@example.com");
    expect(html).toContain("Send verification code");
    expect(html).toContain("Change password");
    expect(html).toContain("Sign out other sessions");
    expect(html).toContain("Web sessions");
    expect(html).toContain("current web session only");
    expect(html).toContain("Devices");
    expect(html).toContain('id="sign-out"');
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
    expect(termsPage("support@rudderhq.dev")).toContain("account deletion requests");
  });
});
