import { describe, expect, it } from "vitest";
import { shouldSyncOrganizationSelectionFromRoute } from "./organization-selection";

describe("shouldSyncOrganizationSelectionFromRoute", () => {
  it("does not resync when selection already matches the route", () => {
    expect(
      shouldSyncOrganizationSelectionFromRoute({
        selectionSource: "route_sync",
        selectedOrganizationId: "pap",
        routeOrganizationId: "pap",
      }),
    ).toBe(false);
  });

  it("defers route sync while a manual organization switch is in flight", () => {
    expect(
      shouldSyncOrganizationSelectionFromRoute({
        selectionSource: "manual",
        selectedOrganizationId: "pap",
        routeOrganizationId: "ret",
      }),
    ).toBe(false);
  });

  it("syncs back to the route organization for non-manual mismatches", () => {
    expect(
      shouldSyncOrganizationSelectionFromRoute({
        selectionSource: "route_sync",
        selectedOrganizationId: "pap",
        routeOrganizationId: "ret",
      }),
    ).toBe(true);
  });
});
