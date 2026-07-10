import { afterEach, describe, expect, it, vi } from "vitest";
import { probeInviteResolutionTarget } from "../routes/access-onboarding.helpers.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

const dnsPromises = await import("node:dns/promises");
const lookupMock = vi.mocked(dnsPromises.lookup);

describe("probeInviteResolutionTarget", () => {
  afterEach(() => {
    lookupMock.mockReset();
    vi.restoreAllMocks();
  });

  it.each([
    "http://127.0.0.1:8080/health",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]:8080/health",
    "http://[::ffff:127.0.0.1]:8080/health",
    "http://[fe80::1]:8080/health",
  ])("rejects a non-public literal without opening a connection: %s", async (url) => {
    const pinnedFetchImpl = vi.fn();

    const probe = await probeInviteResolutionTarget(new URL(url), 1_000, {
      pinnedFetchImpl,
    });

    expect(probe).toMatchObject({
      status: "unreachable",
      method: "HEAD",
      httpStatus: null,
      message: "Private network URLs cannot be inspected",
    });
    expect(lookupMock).not.toHaveBeenCalled();
    expect(pinnedFetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a hostname when any DNS answer is non-public", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    const pinnedFetchImpl = vi.fn();

    const probe = await probeInviteResolutionTarget(
      new URL("https://probe.example/health"),
      1_000,
      { pinnedFetchImpl },
    );

    expect(probe).toMatchObject({
      status: "unreachable",
      httpStatus: null,
      message: "Private network URLs cannot be inspected",
    });
    expect(pinnedFetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a public hostname resolving to a non-public IPv6 address", async () => {
    lookupMock.mockResolvedValue([{ address: "fd12:3456::1", family: 6 }]);
    const pinnedFetchImpl = vi.fn();

    const probe = await probeInviteResolutionTarget(
      new URL("https://probe.example/health"),
      1_000,
      { pinnedFetchImpl },
    );

    expect(probe).toMatchObject({
      status: "unreachable",
      httpStatus: null,
      message: "Private network URLs cannot be inspected",
    });
    expect(pinnedFetchImpl).not.toHaveBeenCalled();
  });

  it("pins the validated DNS answer and keeps HEAD redirects manual", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const pinnedFetchImpl = vi.fn(
      async (
        _url: URL,
        init: RequestInit,
        addresses: ReadonlyArray<{ address: string; family: 4 | 6 }>,
      ) => {
        expect(init.method).toBe("HEAD");
        expect(init.redirect).toBe("manual");
        expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        });
      },
    );

    const probe = await probeInviteResolutionTarget(
      new URL("https://probe.example/health"),
      1_000,
      { pinnedFetchImpl },
    );

    expect(probe).toMatchObject({
      status: "unreachable",
      method: "HEAD",
      httpStatus: 302,
    });
    expect(pinnedFetchImpl).toHaveBeenCalledTimes(1);
  });
});
