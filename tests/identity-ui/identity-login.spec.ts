import { expect, test, type Page } from "@playwright/test";
import { identityClientScript } from "../../identity/src/client-script.js";
import { deviceApprovalPage } from "../../identity/src/pages.js";

async function openSignedInDeviceApproval(
  page: Page,
  userCode: string,
): Promise<string> {
  await page.route("**/identity.js*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: identityClientScript,
    }));
  await page.route("**/device?user_code=*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: deviceApprovalPage(userCode),
    }));
  await page.goto(`/device?user_code=${encodeURIComponent(userCode)}`);
  return userCode;
}

test.describe("Rudder Account login UI", () => {
  test("shows one focused login task at a time and remains responsive", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Welcome to Rudder" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeEnabled();
    await expect(page.locator("#otp-form")).toBeVisible();
    await expect(page.locator("#otp-verify-form")).toBeHidden();
    await expect(page.locator("#password-panel")).toBeHidden();
    await expect(page.locator("#reset-password-form")).toBeHidden();

    const passwordMode = page.locator("#password-mode-toggle");
    await passwordMode.click();
    await expect(passwordMode).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#otp-form")).toBeHidden();
    await expect(page.locator("#password-panel")).toBeVisible();
    await expect(page.locator('#password-form input[name="email"]')).toBeFocused();

    await passwordMode.click();
    await expect(passwordMode).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#otp-form")).toBeVisible();
    await expect(page.locator("#password-panel")).toBeHidden();
    await expect(page.locator('#otp-form input[name="email"]')).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      card: document.querySelector(".auth-card")?.getBoundingClientRect().width ?? 0,
    }));
    expect(dimensions.document).toBe(dimensions.viewport);
    expect(dimensions.card).toBeLessThanOrEqual(dimensions.viewport);
  });

  test("switches to the verification step once and supports changing email", async ({ page }) => {
    let sendCount = 0;
    await page.route("**/api/root-auth/email-otp/send", async (route) => {
      sendCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    });
    await page.goto("/");

    await page.locator("#otp-form").getByLabel("Email address").fill("login-ui@rudderhq.dev");
    const continueButton = page.getByRole("button", { name: "Continue with email" });
    const passwordMode = page.locator("#password-mode-toggle");
    const submitPromise = continueButton.dblclick();
    await expect(passwordMode).toBeDisabled();
    await submitPromise;

    await expect(page.locator("#otp-form")).toBeHidden();
    await expect(page.locator("#otp-verify-form")).toBeVisible();
    await expect(page.locator("#otp-email")).toHaveText("login-ui@rudderhq.dev");
    expect(sendCount).toBe(1);

    await page.getByRole("button", { name: "Change email" }).click();
    await expect(page.locator("#otp-form")).toBeVisible();
    await expect(page.locator("#otp-verify-form")).toBeHidden();
    await expect(page.locator('#otp-form input[name="email"]')).toBeFocused();
  });

  test("keeps email entry recoverable when code delivery fails", async ({ page }) => {
    await page.route("**/api/root-auth/email-otp/send", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Mail transport unavailable" }),
      }));
    await page.goto("/");

    await page.locator("#otp-form").getByLabel("Email address").fill("delivery-test@rudderhq.dev");
    await page.getByRole("button", { name: "Continue with email" }).click();

    await expect(page.locator("#otp-form")).toBeVisible();
    await expect(page.locator("#otp-verify-form")).toBeHidden();
    await expect(page.getByRole("status")).toHaveText("Mail transport unavailable");
    await expect(page.getByRole("status")).toHaveAttribute("data-state", "error");
    await expect(page.getByRole("button", { name: "Continue with email" })).toBeEnabled();
  });

  test("verifies an email code and rejects an unsafe next redirect", async ({ page }) => {
    let verificationBody: { email?: string; token?: string; purpose?: string } = {};
    await page.route("**/api/root-auth/email-otp/send", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.route("**/api/root-auth/email-otp/verify", async (route) => {
      verificationBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.goto("/?next=https://evil.example/collect");

    await page.locator("#otp-form").getByLabel("Email address").fill("owner@rudderhq.dev");
    await page.getByRole("button", { name: "Continue with email" }).click();
    await page.locator("#otp-verify-form").getByLabel("Verification code").fill("123456");
    await page.getByRole("button", { name: "Verify and continue" }).click();

    await expect(page).toHaveURL("/");
    expect(verificationBody).toEqual({
      email: "owner@rudderhq.dev",
      token: "123456",
      purpose: "sign-in",
    });
  });

  test("keeps an invalid email code recoverable", async ({ page }) => {
    await page.route("**/api/root-auth/email-otp/send", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.route("**/api/root-auth/email-otp/verify", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ message: "The code is invalid or expired" }),
      }));
    await page.goto("/");

    await page.locator("#otp-form").getByLabel("Email address").fill("owner@rudderhq.dev");
    await page.getByRole("button", { name: "Continue with email" }).click();
    await page.locator("#otp-verify-form").getByLabel("Verification code").fill("000000");
    await page.getByRole("button", { name: "Verify and continue" }).click();

    await expect(page.locator("#otp-verify-form")).toBeVisible();
    await expect(page.getByRole("status")).toHaveAttribute("data-state", "error");
    await expect(page.getByRole("button", { name: "Verify and continue" })).toBeEnabled();
  });

  test("signs in with a password from the mutually exclusive password mode", async ({ page }) => {
    let signInBody: { email?: string; password?: string } = {};
    await page.route("**/api/root-auth/password/sign-in", async (route) => {
      signInBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.goto("/");
    await page.locator("#password-mode-toggle").click();

    await page.locator("#password-form").getByLabel("Email address").fill("owner@rudderhq.dev");
    await page.locator("#password-form").getByLabel("Password").fill("correct horse battery");
    await page.getByRole("button", { name: "Sign in with password" }).click();

    await expect(page).toHaveURL("/");
    expect(signInBody).toEqual({
      email: "owner@rudderhq.dev",
      password: "correct horse battery",
    });
  });

  test("moves password registration into the single email verification step", async ({ page }) => {
    await page.route("**/api/root-auth/password/sign-up", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.goto("/");
    await page.locator("#password-mode-toggle").click();
    await page.getByText("Create a password account").click();

    const signup = page.locator("#password-signup-form");
    await signup.getByLabel("Email address").fill("new-owner@rudderhq.dev");
    await signup.getByLabel("Password").fill("correct horse battery");
    await signup.getByRole("button", { name: "Create account with password" }).click();

    await expect(page.locator("#password-panel")).toBeHidden();
    await expect(page.locator("#otp-verify-form")).toBeVisible();
    await expect(page.locator("#otp-email")).toHaveText("new-owner@rudderhq.dev");
    await expect(page.locator("#otp-verify-form").getByLabel("Verification code")).toBeFocused();
  });

  for (const responseStatus of [200, 503]) {
    test(`keeps password recovery account-private after a ${responseStatus} response`, async ({ page }) => {
      await page.route("**/api/root-auth/password/reset/request", (route) =>
        route.fulfill({
          status: responseStatus,
          contentType: "application/json",
          body: responseStatus === 200 ? "{}" : JSON.stringify({ message: "Mail transport unavailable" }),
        }));
      await page.goto("/");
      await page.locator("#password-mode-toggle").click();
      await page.getByText("Forgot password?").click();

      const forgot = page.locator("#forgot-password-form");
      await forgot.getByLabel("Email address").fill("private@rudderhq.dev");
      await forgot.getByRole("button", { name: "Send reset code" }).click();

      await expect(page.locator("#reset-password-form")).toBeVisible();
      await expect(page.getByRole("status")).toHaveText(
        "If this account exists, a reset code is on the way.",
      );
      await expect(page.getByRole("status")).toHaveAttribute("data-state", "success");
      await expect(page.locator("#reset-password-form").getByLabel("Reset code")).toBeFocused();
    });
  }

  test("submits a reset code and leaves an invalid attempt recoverable", async ({ page }) => {
    await page.route("**/api/root-auth/password/reset/request", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.route("**/api/root-auth/password/reset/confirm", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: "{}" }));
    await page.goto("/");
    await page.locator("#password-mode-toggle").click();
    await page.getByText("Forgot password?").click();
    await page.locator("#forgot-password-form").getByLabel("Email address").fill("owner@rudderhq.dev");
    await page.getByRole("button", { name: "Send reset code" }).click();

    const reset = page.locator("#reset-password-form");
    await reset.getByLabel("Reset code").fill("000000");
    await reset.getByLabel("New password").fill("replacement password");
    await reset.getByRole("button", { name: "Reset password" }).click();

    await expect(reset).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("The reset code is invalid or expired.");
    await expect(reset.getByRole("button", { name: "Reset password" })).toBeEnabled();
  });

  for (const provider of ["Google", "GitHub"] as const) {
    test(`starts ${provider} OAuth from the visible provider control`, async ({ page }) => {
      let requestProvider = "";
      await page.route("**/api/root-auth/oauth", async (route) => {
        const body = route.request().postDataJSON() as { provider?: string };
        requestProvider = body.provider ?? "";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            redirectUrl: `http://127.0.0.1:3211/?oauth=${requestProvider}`,
          }),
        });
      });
      await page.goto("/");

      await page.getByRole("button", { name: `Continue with ${provider}` }).click();

      await expect(page).toHaveURL(`/?oauth=${provider.toLowerCase()}`);
      expect(requestProvider).toBe(provider.toLowerCase());
    });
  }
});

test.describe("Rudder Account device approval UI", () => {
  test("locks both actions while approving, then replaces them with the success state", async ({
    page,
  }) => {
    const userCode = await openSignedInDeviceApproval(
      page,
      "APRV-2F9K",
    );
    let approveRequests = 0;
    await page.route("**/api/desktop/device-code/approve", async (route) => {
      approveRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 120));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, status: "approved" }),
      });
    });

    await expect(page.getByRole("heading", { name: "Confirm this device" })).toBeVisible();
    await expect(page.locator("#device-user-code")).toHaveText(userCode);
    const approve = page.getByRole("button", { name: "Approve device" });
    const deny = page.getByRole("button", { name: "Deny request" });
    await approve.click();

    await expect(page.getByRole("button", { name: "Approving…" })).toBeDisabled();
    await expect(deny).toBeDisabled();
    await expect(page.getByRole("status")).toHaveText("Approving this device…");
    await expect(page.locator("#device-decision")).toBeHidden();
    await expect(page.locator("#device-result")).toHaveAttribute("data-state", "approved");
    await expect(page.locator("#device-result")).toHaveAttribute("role", "status");
    await expect(page.locator("#device-result")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("#device-result")).toHaveAttribute("aria-atomic", "true");
    await expect(page.getByRole("heading", { name: "Device approved" })).toBeVisible();
    const returnToRudder = page.getByRole("button", { name: "Return to Rudder" });
    await expect(returnToRudder).toBeFocused();
    expect(approveRequests).toBe(1);

    await page.evaluate(() => {
      window.close = () => undefined;
    });
    await returnToRudder.click();
    await expect(page.locator("#auth-status")).toHaveText(
      "You can close this tab and return to Rudder.",
    );
  });

  test("shows a denied result without leaving reusable decision controls", async ({ page }) => {
    await openSignedInDeviceApproval(page, "DENY-7M3Q");
    await page.route("**/api/desktop/device-code/deny", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, status: "denied" }),
      }));

    await page.getByRole("button", { name: "Deny request" }).click();

    await expect(page.locator("#device-decision")).toBeHidden();
    await expect(page.locator("#device-result")).toHaveAttribute("data-state", "denied");
    await expect(page.getByRole("heading", { name: "Request denied" })).toBeVisible();
    await expect(page.getByText("This device was not granted access.")).toBeVisible();
  });

  test("restores both actions after an expired-request error", async ({ page }) => {
    await openSignedInDeviceApproval(page, "EXPR-4T8V");
    await page.route("**/api/desktop/device-code/approve", (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "expired_token" }),
      }));

    await page.getByRole("button", { name: "Approve device" }).click();

    await expect(page.getByRole("status")).toHaveText("This device request is invalid or expired.");
    await expect(page.getByRole("status")).toHaveAttribute("data-state", "error");
    await expect(page.getByRole("button", { name: "Approve device" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Deny request" })).toBeEnabled();
    await expect(page.locator("#device-result")).toBeHidden();
  });
});
