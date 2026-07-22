import { describe, expect, it } from "vitest";
import type { DesktopLocalAppDefinition } from "./desktop-shell";
import {
  localAppDefinitionFromForm,
  localAppDefinitionToForm,
  localAppIdentityMatches,
  resolveLocalAppAttestedWebview,
} from "./local-apps";
import { queryKeys } from "./queryKeys";

const definition: DesktopLocalAppDefinition = {
  id: "binding-1",
  desktopInstallationId: "installation-1",
  appPublicId: "public-1",
  localBindingId: "binding-1",
  title: "Marketing command center",
  executable: "/usr/local/bin/npm",
  argv: ["run", "dev"],
  cwd: "/projects/rudder/mkt/dashboard",
  inheritedEnvNames: ["RUDDER_GROWTH_DB_PATH", "RUDDER_MAIL_DB_PATH"],
  readiness: { path: "/api/health", timeoutMs: 30_000 },
  openPath: "/outreach",
  trustFingerprint: "fingerprint",
  approvedFingerprint: "fingerprint",
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
};

describe("Local App UI contract", () => {
  it("shares status and logs queries by local binding instead of view instance", () => {
    expect(queryKeys.localApps.definitions).toEqual(["local-apps", "definitions"]);
    expect(queryKeys.localApps.status("binding-a")).toEqual(["local-apps", "status", "binding-a"]);
    expect(queryKeys.localApps.logs("binding-a")).toEqual(["local-apps", "logs", "binding-a"]);
  });

  it("matches all three opaque identity fields before using a binding", () => {
    expect(localAppIdentityMatches(definition, {
      desktopInstallationId: "installation-1",
      appPublicId: "public-1",
      localBindingId: "binding-1",
    })).toBe(true);
    expect(localAppIdentityMatches(definition, {
      desktopInstallationId: "installation-2",
      appPublicId: "public-1",
      localBindingId: "binding-1",
    })).toBe(false);
    expect(localAppIdentityMatches(definition, {
      desktopInstallationId: "installation-1",
      appPublicId: "public-2",
      localBindingId: "binding-1",
    })).toBe(false);
  });

  it("round-trips explicit argv and environment rows without shell parsing", () => {
    const form = localAppDefinitionToForm(definition);
    expect(form.argvText).toBe("run\ndev");
    expect(form.environmentNamesText).toBe("RUDDER_GROWTH_DB_PATH\nRUDDER_MAIL_DB_PATH");
    expect(localAppDefinitionFromForm({
      ...form,
      argvText: "run\ndev\n--host=127.0.0.1",
      environmentNamesText: "PATH\nRUDDER_MAIL_DB_PATH\nRUDDER_GROWTH_DB_PATH\nRUDDER_MAIL_DB_PATH",
    })).toEqual({
      ok: true,
      definition: {
        title: definition.title,
        executable: definition.executable,
        argv: ["run", "dev", "--host=127.0.0.1"],
        cwd: definition.cwd,
        inheritedEnvNames: ["RUDDER_GROWTH_DB_PATH", "RUDDER_MAIL_DB_PATH"],
        readiness: { path: "/api/health", timeoutMs: 30_000 },
        openPath: "/outreach",
      },
    });
  });

  it("preserves literal argument whitespace and rejects oversized individual arguments", () => {
    const form = localAppDefinitionToForm(definition);
    const parsed = localAppDefinitionFromForm({
      ...form,
      argvText: "run\n --literal value \n",
    });
    expect(parsed).toMatchObject({
      ok: true,
      definition: { argv: ["run", " --literal value "] },
    });
    expect(localAppDefinitionFromForm({
      ...form,
      argvText: "x".repeat(4_097),
    })).toEqual({
      ok: false,
      error: "Each Local App argument may contain at most 4096 characters.",
    });
  });

  it("rejects invalid editable definitions before invoking Desktop", () => {
    const form = localAppDefinitionToForm(definition);
    expect(localAppDefinitionFromForm({ ...form, readinessPath: "api/health" })).toEqual({
      ok: false,
      error: "Readiness path must start with /.",
    });
    expect(localAppDefinitionFromForm({ ...form, timeoutMs: "100" })).toEqual({
      ok: false,
      error: "Readiness timeout must be between 250 and 120000 milliseconds.",
    });
    expect(localAppDefinitionFromForm({ ...form, environmentNamesText: "NOT-AN-ENV" })).toEqual({
      ok: false,
      error: "Environment variable names may contain only letters, numbers, and underscores.",
    });
  });

  it("accepts only an attested 127.0.0.1 target and returned isolated partition", () => {
    expect(resolveLocalAppAttestedWebview({
      origin: "http://127.0.0.1:43123",
      openPath: "/outreach?range=30",
      partition: "persist:rudder-local-app-opaque",
    })).toEqual({
      src: "http://127.0.0.1:43123/outreach?range=30",
      partition: "persist:rudder-local-app-opaque",
    });
    expect(() => resolveLocalAppAttestedWebview({
      origin: "http://localhost:43123",
      openPath: "/outreach",
      partition: "persist:rudder-local-app-opaque",
    })).toThrow("attested loopback");
    expect(() => resolveLocalAppAttestedWebview({
      origin: "http://127.0.0.1:43123",
      openPath: "https://example.com/outreach",
      partition: "persist:rudder-local-app-opaque",
    })).toThrow("same attested origin");
  });
});
