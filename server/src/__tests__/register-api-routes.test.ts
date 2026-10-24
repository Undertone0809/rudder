import { Router } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerApiRoutes } from "../bootstrap/register-api-routes.js";
import * as localAccountRoutes from "../routes/local-account-auth.js";

const mocks = vi.hoisted(() => ({ organizationRoutes: vi.fn(), projectRoutes: vi.fn() }));

vi.mock("../routes/orgs.js", () => ({ organizationRoutes: mocks.organizationRoutes }));
vi.mock("../routes/projects.js", () => ({ projectRoutes: mocks.projectRoutes }));

beforeEach(() => {
  mocks.organizationRoutes.mockReset();
  mocks.organizationRoutes.mockImplementation(() => Router());
  mocks.projectRoutes.mockReset();
  mocks.projectRoutes.mockImplementation(() => Router());
});

describe("registerApiRoutes", () => {
  it("passes native organization and Project route gates only when public ingress is configured", () => {
    const baseOptions = {
      uiMode: "none", serverPort: 3100, storageService: {}, deploymentMode: "local_trusted",
      deploymentExposure: "private", allowedHostnames: [], bindHost: "127.0.0.1",
      authReady: true, companyDeletionEnabled: false,
    };

    registerApiRoutes({} as never, {
      ...baseOptions,
      rustPublicIngress: {},
    } as never);
    expect(mocks.organizationRoutes.mock.calls.at(-1)?.[4]).toEqual({ nativeResourceRoutes: true });
    expect(mocks.projectRoutes.mock.calls.at(-1)?.[2]).toEqual({
      nativeProjectReads: true,
      nativeProjectWrites: true,
    });

    registerApiRoutes({} as never, baseOptions as never);
    expect(mocks.organizationRoutes.mock.calls.at(-1)?.[4]).toEqual({ nativeResourceRoutes: false });
    expect(mocks.projectRoutes.mock.calls.at(-1)?.[2]).toEqual({
      nativeProjectReads: false,
      nativeProjectWrites: false,
    });
  });

  it("builds the API router from the current server dependencies", () => {
    const router = registerApiRoutes(
      {} as never,
      {
        uiMode: "none",
        serverPort: 3100,
        storageService: {} as never,
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        allowedHostnames: [],
        bindHost: "127.0.0.1",
        authReady: true,
        companyDeletionEnabled: false,
      },
    );

    expect(router).toBeTruthy();
    expect((router as { stack?: unknown[] }).stack?.length ?? 0).toBeGreaterThan(10);
  });
});

afterEach(() => vi.restoreAllMocks());

it("retires the private Node account writer when native lifecycle authority is configured", () => {
  const legacy = vi.spyOn(localAccountRoutes, "localAccountAuthRoutes").mockReturnValue(Router());
  const options = {
    uiMode: "none", serverPort: 3100, storageService: {}, deploymentMode: "local_trusted",
    deploymentExposure: "private", allowedHostnames: [], bindHost: "127.0.0.1",
    authReady: true, companyDeletionEnabled: false, instanceId: "test-installation",
    localAccountExchangePolicy: {},
  };
  registerApiRoutes({} as never, {
    ...options,
    rustPublicIngress: {
      localAccountLifecycle: {
        installationId: "test-installation", expectedIssuer: "https://identity.example",
        identityOrigin: "https://identity.example", audience: "test-audience",
      },
    },
  } as never);
  expect(legacy).not.toHaveBeenCalled();
  registerApiRoutes({} as never, options as never);
  expect(legacy).toHaveBeenCalledOnce();
});
