import { describe, expect, it } from "vitest";
import {
  classifyDevDesktopExit,
  classifyDevServerExit,
} from "./dev-shell-lifecycle.mjs";

describe("dev shell lifecycle", () => {
  it("accepts a server exit only after Desktop ownership is verified", () => {
    expect(classifyDevServerExit({ runtimeOwnerKind: "desktop", shuttingDown: false }))
      .toBe("desktop-managed");
  });

  it("treats a server exit without verified Desktop ownership as fatal", () => {
    expect(classifyDevServerExit({ runtimeOwnerKind: null, shuttingDown: false }))
      .toBe("fatal");
    expect(classifyDevServerExit({ runtimeOwnerKind: "dev_runner", shuttingDown: false }))
      .toBe("fatal");
  });

  it("ignores child exits during orchestrated shutdown", () => {
    expect(classifyDevServerExit({ runtimeOwnerKind: null, shuttingDown: true }))
      .toBe("ignore");
  });

  it("exits the parent when the Desktop-owned runtime closes", () => {
    expect(classifyDevDesktopExit({ desktopOwnsRuntime: true, shuttingDown: false }))
      .toBe("exit-parent");
  });

  it("keeps the dev runtime alive when an attached Desktop closes", () => {
    expect(classifyDevDesktopExit({ desktopOwnsRuntime: false, shuttingDown: false }))
      .toBe("runtime-still-running");
  });
});
