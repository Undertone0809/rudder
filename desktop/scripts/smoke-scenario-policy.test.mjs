import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSmokeScenarioSupported,
  PACKAGED_LOCAL_APPS_ERROR_CODE,
} from "./smoke-scenario-policy.mjs";

test("packaged Local Apps smoke fails closed before launch", () => {
  assert.throws(
    () => assertSmokeScenarioSupported("packaged", "local-apps"),
    (error) => error?.code === PACKAGED_LOCAL_APPS_ERROR_CODE
      && /authenticated Desktop account/u.test(error.message),
  );
});

test("dev Local Apps and packaged account gate remain supported", () => {
  assert.doesNotThrow(() => assertSmokeScenarioSupported("dev", "local-apps"));
  assert.doesNotThrow(() => assertSmokeScenarioSupported("packaged", "account-gate"));
});
