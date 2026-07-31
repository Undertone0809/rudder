import { describe, expect, it } from "vitest";
import {
  DEVICE_AUTHORIZATION_DEFAULT_POLL_INTERVAL_SECONDS,
  evaluateDeviceAuthorizationPoll,
  generateDeviceAuthorizationCodes,
  hashDeviceAuthorizationCode,
  normalizeDeviceAuthorizationUserCode,
  type DeviceAuthorizationPollRecord,
} from "./device-authorization.js";

const now = new Date("2026-07-30T12:00:00.000Z");

function record(
  overrides: Partial<DeviceAuthorizationPollRecord> = {},
): DeviceAuthorizationPollRecord {
  return {
    clientId: "rudder-desktop",
    status: "pending",
    userId: null,
    expiresAt: new Date(now.getTime() + 60_000),
    lastPolledAt: null,
    pollingInterval: DEVICE_AUTHORIZATION_DEFAULT_POLL_INTERVAL_SECONDS,
    ...overrides,
  };
}

describe("Rudder device authorization codes", () => {
  it("generates opaque device codes and human-friendly normalized user codes", () => {
    const first = generateDeviceAuthorizationCodes();
    const second = generateDeviceAuthorizationCodes();

    expect(first.deviceCode).not.toBe(second.deviceCode);
    expect(first.deviceCode.length).toBeGreaterThanOrEqual(40);
    expect(hashDeviceAuthorizationCode(first.deviceCode)).not.toContain(
      first.deviceCode,
    );
    expect(hashDeviceAuthorizationCode(first.deviceCode)).toBe(
      hashDeviceAuthorizationCode(first.deviceCode),
    );
    expect(first.userCode).toMatch(/^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/u);
    expect(normalizeDeviceAuthorizationUserCode(` ${first.userCode.toLowerCase()} `))
      .toBe(first.userCode.replace("-", ""));
  });
});

describe("Rudder device authorization polling", () => {
  it("requires the exact client before revealing request state", () => {
    expect(
      evaluateDeviceAuthorizationPoll(record(), {
        clientId: "another-client",
        now,
      }),
    ).toEqual({ status: "invalid_client" });
  });

  it("reports pending on an allowed poll and slow_down on an early retry", () => {
    expect(
      evaluateDeviceAuthorizationPoll(record(), {
        clientId: "rudder-desktop",
        now,
      }),
    ).toEqual({ status: "authorization_pending", interval: 5 });

    expect(
      evaluateDeviceAuthorizationPoll(
        record({ lastPolledAt: new Date(now.getTime() - 4_000) }),
        { clientId: "rudder-desktop", now },
      ),
    ).toEqual({ status: "slow_down", interval: 10 });
  });

  it("checks expiry before returning an approved Rudder subject", () => {
    expect(
      evaluateDeviceAuthorizationPoll(
        record({
          status: "approved",
          userId: "stable-rudder-user",
          expiresAt: now,
        }),
        { clientId: "rudder-desktop", now },
      ),
    ).toEqual({ status: "expired_token" });
  });

  it("returns the stable Rudder subject only for a valid approved request", () => {
    expect(
      evaluateDeviceAuthorizationPoll(
        record({ status: "approved", userId: "stable-rudder-user" }),
        { clientId: "rudder-desktop", now },
      ),
    ).toEqual({ status: "approved", userId: "stable-rudder-user" });
    expect(
      evaluateDeviceAuthorizationPoll(
        record({ status: "approved", userId: null }),
        { clientId: "rudder-desktop", now },
      ),
    ).toEqual({ status: "invalid_grant" });
  });

  it("maps a user denial to the RFC 8628 access_denied error", () => {
    expect(
      evaluateDeviceAuthorizationPoll(record({ status: "denied" }), {
        clientId: "rudder-desktop",
        now,
      }),
    ).toEqual({ status: "access_denied" });
  });
});
