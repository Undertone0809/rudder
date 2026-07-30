// @vitest-environment jsdom

import type { DevServerHealthStatus } from "@/api/health";
import type { ToastInput } from "@/context/ToastContext";
import type { ChatInlineAnnotationInput } from "@rudderhq/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANNOTATION_RUNTIME_RESTART_TOAST_ID,
  blockStaleAnnotationSubmission,
  resolveAnnotationDraftPersistence,
} from "./chat-annotation-runtime";

const annotation = { id: "annotation-1" } as ChatInlineAnnotationInput;
const staleDevServer = {
  enabled: true,
  restartRequired: true,
} as DevServerHealthStatus;

afterEach(() => {
  Reflect.deleteProperty(window, "desktopShell");
});

describe("blockStaleAnnotationSubmission", () => {
  it("blocks annotation submissions with a stable persistent warning", () => {
    const pushToast = vi.fn<(input: ToastInput) => string | null>(() => "toast");

    expect(blockStaleAnnotationSubmission({
      annotations: [annotation],
      devServer: staleDevServer,
      pushToast,
    })).toBe(true);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({
      id: ANNOTATION_RUNTIME_RESTART_TOAST_ID,
      dedupeKey: expect.stringContaining(`${ANNOTATION_RUNTIME_RESTART_TOAST_ID}:`),
      persistent: true,
    }));
  });

  it("does not block ordinary messages or a fresh runtime", () => {
    const pushToast = vi.fn<(input: ToastInput) => string | null>(() => "toast");

    expect(blockStaleAnnotationSubmission({
      annotations: [],
      devServer: staleDevServer,
      pushToast,
    })).toBe(false);
    expect(blockStaleAnnotationSubmission({
      annotations: [annotation],
      devServer: { ...staleDevServer, restartRequired: false },
      pushToast,
    })).toBe(false);
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("reports a failed Desktop restart and keeps the action rejected", async () => {
    const restartError = new Error("restart failed");
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: { restart: vi.fn().mockRejectedValue(restartError) },
    });
    const inputs: ToastInput[] = [];
    const pushToast = vi.fn((input: ToastInput) => {
      inputs.push(input);
      return input.id ?? "toast";
    });

    blockStaleAnnotationSubmission({
      annotations: [annotation],
      devServer: staleDevServer,
      pushToast,
    });

    await expect(inputs[0]?.action?.onClick?.()).rejects.toBe(restartError);
    expect(inputs[1]).toEqual(expect.objectContaining({
      title: "Could not restart Rudder",
      tone: "error",
    }));
  });

  it("does not offer a destructive restart for an in-memory draft", () => {
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: { restart: vi.fn() },
    });
    const inputs: ToastInput[] = [];

    blockStaleAnnotationSubmission({
      annotations: [annotation],
      devServer: staleDevServer,
      draftPersistence: "memory",
      pushToast: (input) => {
        inputs.push(input);
        return input.id ?? "toast";
      },
    });

    expect(inputs[0]?.body).toContain("Copy it before restarting Rudder");
    expect(inputs[0]?.action).toBeUndefined();
  });
});

describe("resolveAnnotationDraftPersistence", () => {
  it("treats pending files as in-memory and preserves explicit in-memory callers", () => {
    expect(resolveAnnotationDraftPersistence({ pendingFileCount: 0 })).toBe("durable");
    expect(resolveAnnotationDraftPersistence({ pendingFileCount: 1 })).toBe("memory");
    expect(resolveAnnotationDraftPersistence({
      explicit: "memory",
      pendingFileCount: 0,
    })).toBe("memory");
  });
});
