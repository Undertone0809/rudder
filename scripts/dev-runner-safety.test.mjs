import assert from "node:assert/strict";
import test from "node:test";
import { assertDevRuntimeTakeoverAllowed } from "./dev-runner-safety.mjs";

function healthyProbe(ownerKind) {
  return {
    kind: "healthy",
    descriptor: {
      instanceId: "dev",
      localEnv: "dev",
      pid: 4312,
      ownerKind,
    },
    health: {
      status: "ok",
      runtimeOwnerKind: ownerKind,
    },
  };
}

test("allows a dev runner to replace an earlier dev runner", () => {
  assert.doesNotThrow(() => {
    assertDevRuntimeTakeoverAllowed(healthyProbe("dev_runner"), {
      instanceId: "dev",
      localEnv: "dev",
    });
  });
});

test("refuses to stop a desktop-owned runtime", () => {
  assert.throws(
    () => {
      assertDevRuntimeTakeoverAllowed(healthyProbe("desktop"), {
        instanceId: "dev",
        localEnv: "dev",
      });
    },
    /Refusing to take over dev instance 'dev' from desktop runtime pid 4312/,
  );
});

test("refuses a production target even when no runtime is currently healthy", () => {
  assert.throws(
    () => {
      assertDevRuntimeTakeoverAllowed({ kind: "missing" }, {
        instanceId: "default",
        localEnv: "prod_local",
      });
    },
    /Refusing to start pnpm dev against protected production target prod_local instance 'default'/,
  );
});

test("refuses the default instance even when it is mislabeled as dev", () => {
  assert.throws(
    () => {
      assertDevRuntimeTakeoverAllowed({ kind: "missing" }, {
        instanceId: "default",
        localEnv: "dev",
      });
    },
    /protected production target dev instance 'default'/,
  );
});

test("does not block startup when no healthy runtime exists", () => {
  assert.doesNotThrow(() => {
    assertDevRuntimeTakeoverAllowed({ kind: "missing" }, {
      instanceId: "dev",
      localEnv: "dev",
    });
  });
});
