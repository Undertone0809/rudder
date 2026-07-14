import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  RuntimeSupervisor,
  supervisedStart,
} from "../runtime/runtime-supervisor.js";

describe("RuntimeSupervisor", () => {
  it("awaits disposers in reverse acquisition order", async () => {
    const events: string[] = [];
    let releaseHttp!: () => void;
    const httpClosed = new Promise<void>((resolve) => {
      releaseHttp = resolve;
    });
    const supervisor = new RuntimeSupervisor();

    supervisor.own("database", async () => {
      events.push("database");
    });
    supervisor.own("app", async () => {
      events.push("app");
    });
    supervisor.own("http", async () => {
      events.push("http:start");
      await httpClosed;
      events.push("http:end");
    });

    const disposing = supervisor.dispose();
    await Promise.resolve();

    expect(events).toEqual(["http:start"]);

    releaseHttp();
    await disposing;

    expect(events).toEqual(["http:start", "http:end", "app", "database"]);
  });

  it("runs each disposer once across concurrent and repeated dispose calls", async () => {
    const disposeResource = vi.fn(async () => undefined);
    const supervisor = new RuntimeSupervisor();
    supervisor.own("resource", disposeResource);

    const firstDispose = supervisor.dispose();
    const secondDispose = supervisor.dispose();
    const thirdDispose = supervisor.dispose();

    expect(secondDispose).toBe(firstDispose);
    expect(thirdDispose).toBe(firstDispose);

    await Promise.all([firstDispose, secondDispose, thirdDispose]);
    await supervisor.dispose();

    expect(disposeResource).toHaveBeenCalledTimes(1);
  });

  it("publishes disposal state before invoking a synchronous disposer", async () => {
    const events: string[] = [];
    let nestedDispose: Promise<void> | null = null;
    let registrationError: unknown;
    const supervisor = new RuntimeSupervisor();

    supervisor.own("older", () => {
      events.push("older");
    });
    supervisor.own("newer", () => {
      events.push("newer:start");
      try {
        supervisor.own("late", () => {
          events.push("late");
        });
      } catch (error) {
        registrationError = error;
      }
      nestedDispose = supervisor.dispose();
      events.push("newer:end");
    });

    const outerDispose = supervisor.dispose();
    await outerDispose;

    expect(nestedDispose).not.toBe(outerDispose);
    await expect(nestedDispose).resolves.toBeUndefined();
    expect(registrationError).toMatchObject({
      message: "Cannot own runtime resource after disposal has started",
    });
    expect(events).toEqual(["newer:start", "newer:end", "older"]);
  });

  it("does not self-await when a disposer returns a reentrant dispose", async () => {
    const events: string[] = [];
    const supervisor = new RuntimeSupervisor();

    supervisor.own("older", () => {
      events.push("older");
    });
    supervisor.own("newer", () => {
      events.push("newer");
      return supervisor.dispose();
    });

    const outcome = await Promise.race([
      supervisor.dispose().then(() => "disposed"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("timed-out"), 150);
      }),
    ]);

    expect(outcome).toBe("disposed");
    expect(events).toEqual(["newer", "older"]);
  });

  it("does not self-await when an async disposer reenters after awaiting", async () => {
    const events: string[] = [];
    const supervisor = new RuntimeSupervisor();

    supervisor.own("older", () => {
      events.push("older");
    });
    supervisor.own("newer", async () => {
      events.push("newer:start");
      await Promise.resolve();
      await supervisor.dispose();
      events.push("newer:end");
    });

    const outcome = await Promise.race([
      supervisor.dispose().then(() => "disposed"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("timed-out"), 150);
      }),
    ]);

    expect(outcome).toBe("disposed");
    expect(events).toEqual(["newer:start", "newer:end", "older"]);
  });

  it("makes detached disposer descendants wait for remaining cleanup", async () => {
    const events: string[] = [];
    let releaseOlder!: () => void;
    let markDescendantStarted!: () => void;
    let descendantDispose: Promise<void> | null = null;
    let descendantFinished = false;
    const olderGate = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const descendantStarted = new Promise<void>((resolve) => {
      markDescendantStarted = resolve;
    });
    const supervisor = new RuntimeSupervisor();

    supervisor.own("older", async () => {
      events.push("older:start");
      await olderGate;
      events.push("older:end");
    });
    supervisor.own("newer", () => {
      setTimeout(() => {
        descendantDispose = supervisor.dispose();
        void descendantDispose.then(() => {
          descendantFinished = true;
          events.push("descendant:end");
        });
        markDescendantStarted();
      }, 0);
    });

    const outerDispose = supervisor.dispose();
    await descendantStarted;

    expect(descendantDispose).toBe(outerDispose);
    await Promise.resolve();
    expect(descendantFinished).toBe(false);

    releaseOlder();
    await outerDispose;
    await descendantDispose;

    expect(events).toEqual(["older:start", "older:end", "descendant:end"]);
  });

  it("disables the disposer async context after cleanup", async () => {
    const supervisor = new RuntimeSupervisor();
    const context = (
      supervisor as unknown as { disposerContext: AsyncLocalStorage<unknown> }
    ).disposerContext;
    const disable = vi.spyOn(context, "disable");
    supervisor.own("resource", async () => undefined);

    await supervisor.dispose();

    expect(disable).toHaveBeenCalledTimes(1);
  });

  it("continues after a disposer fails and reports the resource name", async () => {
    const failure = new Error("http close failed");
    const disposeDatabase = vi.fn(async () => undefined);
    const onDisposeError = vi.fn();
    const supervisor = new RuntimeSupervisor({ onDisposeError });

    supervisor.own("database", disposeDatabase);
    supervisor.own("http", async () => {
      throw failure;
    });

    await expect(supervisor.dispose()).resolves.toBeUndefined();

    expect(onDisposeError).toHaveBeenCalledWith({
      name: "http",
      error: failure,
    });
    expect(disposeDatabase).toHaveBeenCalledTimes(1);
  });

  it("rejects new ownership after disposal begins", async () => {
    const supervisor = new RuntimeSupervisor();
    supervisor.own("existing", async () => undefined);

    const disposing = supervisor.dispose();

    expect(() => supervisor.own("late", async () => undefined)).toThrow(
      "Cannot own runtime resource after disposal has started",
    );
    await disposing;
  });
});

describe("supervisedStart", () => {
  it("rolls back acquired resources and rethrows the original startup error", async () => {
    const startupError = new Error("listen failed");
    const closeDatabase = vi.fn(async () => undefined);
    const supervisor = new RuntimeSupervisor();

    await expect(supervisedStart(supervisor, async () => {
      supervisor.own("database", closeDatabase);
      throw startupError;
    })).rejects.toBe(startupError);

    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it("keeps resources alive after successful startup", async () => {
    const closeDatabase = vi.fn(async () => undefined);
    const supervisor = new RuntimeSupervisor();

    const result = await supervisedStart(supervisor, async () => {
      supervisor.own("database", closeDatabase);
      return { ready: true };
    });

    expect(result).toEqual({ ready: true });
    expect(closeDatabase).not.toHaveBeenCalled();

    await supervisor.dispose();
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it("preserves the startup error when the cleanup error reporter throws", async () => {
    const startupError = new Error("listen failed");
    const cleanupError = new Error("http close failed");
    const reporterError = new Error("cleanup reporter failed");
    const closeDatabase = vi.fn(async () => undefined);
    const supervisor = new RuntimeSupervisor({
      onDisposeError: () => {
        throw reporterError;
      },
    });

    await expect(supervisedStart(supervisor, async () => {
      supervisor.own("database", closeDatabase);
      supervisor.own("http", async () => {
        throw cleanupError;
      });
      throw startupError;
    })).rejects.toBe(startupError);

    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });
});
