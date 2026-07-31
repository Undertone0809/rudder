export const identityClientScript = String.raw`
(async () => {
  const status = document.querySelector("#auth-status");
  const otpForm = document.querySelector("#otp-form");
  const verifyForm = document.querySelector("#otp-verify-form");
  const otpEmailTarget = document.querySelector("#otp-email");
  const changeEmailButton = document.querySelector("#change-email");
  const passwordModeToggle = document.querySelector("#password-mode-toggle");
  const passwordPanel = document.querySelector("#password-panel");
  let otpEmail = "";
  let otpPurpose = "sign-in";
  const next = new URLSearchParams(location.search).get("next");
  let safeNext = "/";
  let requestedLoginMethod = "";
  let requestedLoginEmail = "";
  let requestedLoginIntent = "";
  let requestedDesktopBinding = null;
  try {
    const rawNext = next || "/";
    const rawPath = rawNext.split(/[?#]/u, 1)[0] || "/";
    const candidate = new URL(rawNext, location.origin);
    if (
      candidate.origin === location.origin &&
      !/%2f|%5c/iu.test(rawPath) &&
      !rawPath.includes("\\")
    ) {
      const intent = candidate.searchParams.get("login_intent") || "";
      if (/^[A-Za-z0-9_-]{32,2048}$/u.test(intent)) {
        requestedLoginIntent = intent;
        requestedDesktopBinding = {
          client_id: candidate.searchParams.get("client_id") || "",
          code_challenge: candidate.searchParams.get("code_challenge") || "",
          redirect_uri: candidate.searchParams.get("redirect_uri") || "",
          state: candidate.searchParams.get("state") || "",
        };
      }
      candidate.searchParams.delete("login_intent");
      safeNext = candidate.pathname + candidate.search + candidate.hash;
    }
  } catch {}

  const message = (text, error = false) => {
    status.textContent = text;
    if (status.dataset) status.dataset.state = error ? "error" : "success";
    status.style.color = "";
  };
  const setBusy = (button, busy) => {
    if (!button) return;
    button.dataset.loading = busy ? "true" : "false";
    button.setAttribute?.("aria-busy", busy ? "true" : "false");
    button.disabled = busy;
  };
  const request = async (path, body) => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.message || value.error || "Unable to sign in");
    return value;
  };

  document.querySelector("#recovery-password-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    if (submit?.disabled) return;
    setBusy(submit, true);
    try {
      const data = new FormData(form);
      const result = await request("/api/root-auth/password/recovery/complete", {
        newPassword: data.get("password").toString(),
      });
      message(
        result.localSessionsRevoked
          ? "Password reset. Browser sessions and Rudder Desktop cloud access were revoked. Existing Local Server sessions end at expiry or next sync."
          : "Password reset, but device revocation is still pending. Contact support before signing in.",
        !result.localSessionsRevoked,
      );
      if (result.localSessionsRevoked) {
        form.hidden = true;
        setTimeout(() => location.assign("/"), 900);
      }
    } catch (error) {
      message(error.message || "Unable to complete password recovery.", true);
      setBusy(submit, false);
    }
  });

  document.querySelectorAll("[data-social]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      setBusy(button, true);
      try {
        message("Opening secure sign in…");
        const result = await request("/api/root-auth/oauth", {
          provider: button.dataset.social,
          nextPath: safeNext,
        });
        if (!result.redirectUrl) throw new Error("Provider sign in is unavailable");
        location.assign(result.redirectUrl);
      } catch (error) {
        message(error.message || "Unable to sign in", true);
        setBusy(button, false);
      }
    });
  });

  otpForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = otpForm.querySelector('button[type="submit"]');
    if (submit?.disabled) return;
    setBusy(submit, true);
    setBusy(passwordModeToggle, true);
    otpEmail = new FormData(otpForm).get("email").toString();
    otpPurpose = "sign-in";
    try {
      await request("/api/root-auth/email-otp/send", {
        email: otpEmail,
        nextPath: safeNext,
      });
      otpForm.hidden = true;
      verifyForm.hidden = false;
      if (otpEmailTarget) otpEmailTarget.textContent = otpEmail;
      message("If this email can receive a code, it is on the way.");
      verifyForm.querySelector("input").focus();
    } catch (error) {
      message(error.message || "Unable to send a verification code.", true);
    } finally {
      setBusy(submit, false);
      setBusy(passwordModeToggle, false);
    }
  });

  changeEmailButton?.addEventListener("click", () => {
    verifyForm.hidden = true;
    otpForm.hidden = false;
    otpForm.querySelector('input[name="email"]').focus();
    message("");
  });

  passwordModeToggle?.addEventListener("click", () => {
    const passwordMode = passwordPanel.hidden;
    passwordPanel.hidden = !passwordMode;
    passwordModeToggle.setAttribute("aria-expanded", passwordMode ? "true" : "false");
    otpForm.hidden = passwordMode;
    verifyForm.hidden = true;
    passwordModeToggle.textContent = passwordMode
      ? "Use email code instead"
      : "Use password instead";
    if (passwordMode) {
      passwordPanel.querySelector('input[name="email"]').focus();
    } else {
      otpForm.querySelector('input[name="email"]').focus();
    }
    message("");
  });

  verifyForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = verifyForm.querySelector('button[type="submit"]');
    if (submit?.disabled) return;
    setBusy(submit, true);
    try {
      await request("/api/root-auth/email-otp/verify", {
        email: otpEmail,
        token: new FormData(verifyForm).get("otp").toString(),
        purpose: otpPurpose,
      });
      location.assign(safeNext);
    } catch (error) {
      message(error.message || "The code is invalid or expired", true);
      setBusy(submit, false);
    }
  });

  document.querySelector("#password-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector?.('button[type="submit"]');
    if (submit?.disabled) return;
    setBusy(submit, true);
    const data = new FormData(event.currentTarget);
    try {
      await request("/api/root-auth/password/sign-in", {
        email: data.get("email").toString(),
        password: data.get("password").toString(),
      });
      location.assign(safeNext);
    } catch {
      message("The email or password is incorrect.", true);
      setBusy(submit, false);
    }
  });

  document.querySelector("#password-signup-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    if (submit?.disabled) return;
    setBusy(submit, true);
    const data = new FormData(event.currentTarget);
    try {
      const result = await request("/api/root-auth/password/sign-up", {
        email: data.get("email").toString(),
        password: data.get("password").toString(),
      });
      if (result.signedIn) {
        location.assign(safeNext);
        return;
      }
      otpEmail = data.get("email").toString();
      otpPurpose = "email-verification";
      otpForm.hidden = true;
      passwordPanel.hidden = true;
      passwordModeToggle.setAttribute("aria-expanded", "false");
      passwordModeToggle.textContent = "Use password instead";
      verifyForm.hidden = false;
      if (otpEmailTarget) otpEmailTarget.textContent = otpEmail;
      message("Check your email to verify this account.");
      verifyForm.querySelector("input").focus();
    } catch {
      message("Check your email to continue. If the account exists, sign in instead.");
    } finally {
      setBusy(submit, false);
    }
  });

  const forgotForm = document.querySelector("#forgot-password-form");
  const resetForm = document.querySelector("#reset-password-form");
  let resetEmail = "";
  forgotForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = forgotForm.querySelector('button[type="submit"]');
    if (submit?.disabled) return;
    setBusy(submit, true);
    resetEmail = new FormData(forgotForm).get("email").toString();
    try {
      await request("/api/root-auth/password/reset/request", {
        email: resetEmail,
        nextPath: safeNext,
      });
    } catch {
      // Password recovery must not reveal whether an account or mailbox exists.
    } finally {
      resetForm.hidden = false;
      message("If this account exists, a reset code is on the way.");
      resetForm.querySelector("input").focus();
      setBusy(submit, false);
    }
  });
  resetForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = resetForm.querySelector('button[type="submit"]');
    if (submit?.disabled) return;
    setBusy(submit, true);
    const data = new FormData(resetForm);
    try {
      await request("/api/root-auth/password/reset/confirm", {
        email: resetEmail,
        token: data.get("otp").toString(),
        newPassword: data.get("password").toString(),
      });
      message("Password updated. You can sign in with it now.");
    } catch {
      message("The reset code is invalid or expired.", true);
    } finally {
      setBusy(submit, false);
    }
  });

  const setPasswordForm = document.querySelector("#set-password-form");
  document.querySelector("#set-password-request-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await request("/api/root-auth/password/reauthenticate", {});
      setPasswordForm.hidden = false;
      message("A verification code is on the way.");
    } catch {
      message("Unable to send a verification code.", true);
    }
  });
  setPasswordForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(setPasswordForm);
    try {
      await request("/api/root-auth/password/update", {
        verificationCode: data.get("otp").toString(),
        newPassword: data.get("newPassword").toString(),
        revokeOthers: data.get("revokeOthers") === "yes",
      });
      message(
        data.get("revokeOthers") === "yes"
          ? "Password set. Other browsers and Rudder Desktop cloud access were revoked."
          : "Password set. Existing browser and Rudder Desktop sessions remain signed in.",
      );
    } catch {
      message("The code is invalid, expired, or a password is already set.", true);
    }
  });
  const signOutMessages = {
    current: "Signed out of this browser.",
    others: "Other browser sessions signed out. This session remains active.",
    global: "Signed out of every browser and revoked Rudder Desktop cloud access. Existing Local Server sessions end at expiry or next sync.",
  };
  document.querySelectorAll("[data-sign-out-scope]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      const scope = button.dataset.signOutScope;
      if (!["current", "others", "global"].includes(scope)) return;
      setBusy(button, true);
      try {
        await request("/api/root-auth/sign-out", { scope });
        message(signOutMessages[scope]);
        if (scope !== "others") location.assign("/");
      } catch {
        message("Unable to sign out.", true);
        setBusy(button, false);
      }
    });
  });

  const deviceList = document.querySelector("#device-list");
  if (deviceList) {
    fetch("/api/account/devices").then(async (response) => {
      if (!response.ok) throw new Error();
      const result = await response.json();
      deviceList.replaceChildren();
      for (const device of result.devices) {
        const row = document.createElement("p");
        const name = document.createElement("span");
        name.textContent = device.displayName + (device.current ? " (current)" : "");
        const revoke = document.createElement("button");
        revoke.type = "button";
        revoke.textContent = "Revoke";
        revoke.addEventListener("click", async () => {
          const response = await fetch("/api/account/devices/" + encodeURIComponent(device.id), { method: "DELETE" });
          if (response.ok) row.remove();
        });
        row.append(name, revoke);
        deviceList.append(row);
      }
    }).catch(() => { deviceList.textContent = "Unable to load devices."; });
  }

  const userCode = document.querySelector("#device-user-code")?.textContent?.trim();
  for (const [id, action] of [["#approve-device", "approve"], ["#deny-device", "deny"]]) {
    document.querySelector(id)?.addEventListener("click", async () => {
      try {
        await request("/api/desktop/device-code/" + action, { userCode });
        message(action === "approve" ? "Device approved. You can return to Rudder." : "Device denied.");
      } catch {
        message("This device request is invalid or expired.", true);
      }
    });
  }

  if (requestedLoginIntent && requestedDesktopBinding) {
    try {
      const hint = await request("/api/desktop/sign-in-intent/resolve", {
        ...requestedDesktopBinding,
        intent: requestedLoginIntent,
      });
      if (["google", "github", "email_otp", "password", "password_reset"].includes(hint.method)) {
        requestedLoginMethod = hint.method;
      }
      if (
        typeof hint.email === "string"
        && hint.email.length <= 254
        && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(hint.email)
      ) {
        requestedLoginEmail = hint.email;
      }
    } catch {
      message("The Desktop sign-in handoff expired. Choose a sign-in method to continue.", true);
    }
  }
  if (requestedLoginEmail) {
    document.querySelectorAll('input[name="email"]').forEach((input) => {
      input.value = requestedLoginEmail;
    });
  }
  if (requestedLoginMethod === "google" || requestedLoginMethod === "github") {
    document.querySelector('[data-social="' + requestedLoginMethod + '"]')?.click?.();
  } else if (requestedLoginMethod === "password" || requestedLoginMethod === "password_reset") {
    passwordModeToggle?.click?.();
    if (requestedLoginMethod === "password_reset") {
      const forgotPasswordForm = document.querySelector("#forgot-password-form");
      const disclosure = forgotPasswordForm?.closest?.("details");
      if (disclosure) disclosure.open = true;
      forgotPasswordForm?.querySelector?.('input[name="email"]')?.focus?.();
    }
  } else if (requestedLoginMethod === "email_otp") {
    otpForm?.querySelector?.('input[name="email"]')?.focus?.();
  }
})();
`;
