export const identityClientScript = String.raw`
(() => {
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
  try {
    const candidate = new URL(next || "/", location.origin);
    if (
      candidate.origin === location.origin &&
      !/%2f|%5c/iu.test(next || "") &&
      !(next || "").includes("\\")
    ) {
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

  document.querySelectorAll("[data-social]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      setBusy(button, true);
      try {
        message("Opening secure sign in…");
        const result = await request("/api/auth/sign-in/social", {
          provider: button.dataset.social,
          callbackURL: safeNext,
        });
        if (!result.url) throw new Error("Provider sign in is unavailable");
        location.assign(result.url);
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
      await request("/api/auth/email-otp/send-verification-otp", {
        email: otpEmail,
        type: "sign-in",
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
      await request(
        otpPurpose === "email-verification"
          ? "/api/auth/email-otp/verify-email"
          : "/api/auth/sign-in/email-otp",
        {
        email: otpEmail,
        otp: new FormData(verifyForm).get("otp").toString(),
        },
      );
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
      await request("/api/auth/sign-in/email", {
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
      await request("/api/auth/sign-up/email", {
        name: data.get("name").toString(),
        email: data.get("email").toString(),
        password: data.get("password").toString(),
      });
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
      await request("/api/auth/email-otp/request-password-reset", { email: resetEmail });
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
      await request("/api/auth/email-otp/reset-password", {
        email: resetEmail,
        otp: data.get("otp").toString(),
        password: data.get("password").toString(),
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
      await request("/api/account/password/verification", {});
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
      await request("/api/account/password", {
        otp: data.get("otp").toString(),
        newPassword: data.get("newPassword").toString(),
      });
      message("Password set.");
    } catch {
      message("The code is invalid, expired, or a password is already set.", true);
    }
  });
  document.querySelector("#change-password-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await request("/api/auth/change-password", {
        currentPassword: data.get("currentPassword").toString(),
        newPassword: data.get("newPassword").toString(),
        revokeOtherSessions: data.get("revokeOtherSessions") === "on",
      });
      message("Password changed.");
    } catch {
      message("The current password is incorrect or the new password is invalid.", true);
    }
  });

  const webSessionList = document.querySelector("#web-session-list");
  const loadWebSessions = async () => {
    if (!webSessionList) return;
    try {
      const response = await fetch("/api/account/web-sessions");
      if (!response.ok) throw new Error();
      const result = await response.json();
      webSessionList.replaceChildren();
      for (const session of result.sessions) {
        const row = document.createElement("p");
        const description = document.createElement("span");
        const agent = session.userAgent || "Unknown browser";
        const address = session.ipAddress ? " · " + session.ipAddress : "";
        description.textContent =
          agent + address + (session.current ? " (current web session)" : "");
        row.append(description);
        if (!session.current) {
          const revoke = document.createElement("button");
          revoke.type = "button";
          revoke.textContent = "Sign out";
          revoke.addEventListener("click", async () => {
            const response = await fetch(
              "/api/account/web-sessions/" + encodeURIComponent(session.id),
              { method: "DELETE" },
            );
            if (response.ok) row.remove();
            else message("Unable to sign out that web session.", true);
          });
          row.append(revoke);
        }
        webSessionList.append(row);
      }
    } catch {
      webSessionList.textContent = "Unable to load web sessions.";
    }
  };
  void loadWebSessions();

  document.querySelector("#revoke-other-web-sessions")?.addEventListener("click", async () => {
    try {
      await request("/api/account/web-sessions/revoke-others", {});
      await loadWebSessions();
      message("Other web sessions signed out. This session remains active.");
    } catch {
      message("Unable to sign out other web sessions.", true);
    }
  });

  document.querySelector("#sign-out")?.addEventListener("click", async () => {
    try {
      await request("/api/auth/sign-out", {});
      location.assign("/");
    } catch {
      message("Unable to sign out.", true);
    }
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
        await request("/api/auth/device/" + action, { userCode });
        message(action === "approve" ? "Device approved. You can return to Rudder." : "Device denied.");
      } catch {
        message("This device request is invalid or expired.", true);
      }
    });
  }
})();
`;
