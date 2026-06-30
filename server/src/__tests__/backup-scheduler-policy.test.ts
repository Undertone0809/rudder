import { describe, expect, it } from "vitest";
import { shouldStartAutomaticBackupSchedulers } from "../backup-scheduler-policy.js";

describe("shouldStartAutomaticBackupSchedulers", () => {
  it.each([
    ["dev", false],
    ["development", false],
    ["e2e", false],
    ["test", false],
    ["", false],
    [undefined, false],
    ["prod_local", true],
    ["production", true],
  ])("returns %s based on the Rudder local environment", (localEnv, expected) => {
    expect(shouldStartAutomaticBackupSchedulers(localEnv)).toBe(expected);
  });
});
