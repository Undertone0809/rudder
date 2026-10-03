// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatRuntimeSensitiveInput,
  type ChatRuntimeSensitiveInputProps,
} from "./ChatRuntimeSensitiveInput";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const request = {
  requestId: "native-request-1",
  kind: "sudo",
  prompt: "A system password is required to continue.",
} satisfies ChatRuntimeSensitiveInputProps["request"];

let mounted: Array<{ root: Root; host: HTMLDivElement; unmounted: boolean }> = [];

function unmountRoot(entry: (typeof mounted)[number]) {
  if (entry.unmounted) return;
  entry.unmounted = true;
  act(() => entry.root.unmount());
  entry.host.remove();
}

function renderInput(props: Partial<ChatRuntimeSensitiveInputProps> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const entry = { root, host, unmounted: false };
  mounted.push(entry);
  const resolvedProps: ChatRuntimeSensitiveInputProps = {
    request,
    onRespond: vi.fn(async () => undefined),
    onCancel: vi.fn(),
    ...props,
  };

  act(() => root.render(<ChatRuntimeSensitiveInput {...resolvedProps} />));
  return { host, root, props: resolvedProps, unmount: () => unmountRoot(entry) };
}

afterEach(() => {
  for (const entry of mounted.splice(0)) unmountRoot(entry);
});

describe("ChatRuntimeSensitiveInput", () => {
  it("renders request metadata as a focused password form with keyboard cancellation", async () => {
    let input: HTMLInputElement | null = null;
    const onCancel = vi.fn((_request: ChatRuntimeSensitiveInputProps["request"]) => {
      expect(input?.value).toBe("");
    });
    const { host, props } = renderInput({ onCancel });
    input = host.querySelector<HTMLInputElement>("input");

    expect(host.textContent).toContain("System password requested");
    expect(host.textContent).toContain(request.prompt);
    expect(input?.type).toBe("password");
    expect(input?.getAttribute("autocomplete")).toBe("off");
    expect(document.activeElement).toBe(input);

    if (!input) throw new Error("Password input was not rendered.");
    await act(async () => {
      input.value = "sudo-password-example";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(input.value).toBe("");
    expect(props.onCancel).toHaveBeenCalledWith(request);
    expect(host.textContent).not.toContain("sudo-password-example");
  });

  it("clears the password before invoking the async response and locks while pending", async () => {
    let resolveResponse!: () => void;
    let host: HTMLDivElement | null = null;
    let input: HTMLInputElement | null = null;
    const responsePromise = new Promise<void>((resolve) => { resolveResponse = resolve; });
    const onRespond = vi.fn((_request: ChatRuntimeSensitiveInputProps["request"], value: string) => {
      expect(input?.type).toBe("password");
      expect(input?.value).toBe("");
      return responsePromise.then(() => {
        expect(value).toBe("runtime-secret-example");
      });
    });
    const rendered = renderInput({ onRespond });
    host = rendered.host;
    const form = host.querySelector("form");
    input = host.querySelector<HTMLInputElement>("input");

    if (!form || !input) throw new Error("Sensitive input form was not rendered.");
    await act(async () => {
      input.value = "runtime-secret-example";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      form.requestSubmit();
    });

    expect(onRespond).toHaveBeenCalledWith(request, "runtime-secret-example");
    expect(input.value).toBe("");
    expect(form.getAttribute("aria-busy")).toBe("true");
    expect(host.textContent).toContain("Sending response...");
    expect(host.textContent).not.toContain("runtime-secret-example");
    expect((host.querySelector("button[type='submit']") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onRespond).toHaveBeenCalledTimes(1);

    await act(async () => resolveResponse());
    expect(host.textContent).toContain("Response sent.");
    expect(host.textContent).not.toContain("runtime-secret-example");
  });

  it("shows a generic retryable error and never renders rejected secret text", async () => {
    const submittedValue = "provider-echoed-secret-example";
    const onRespond = vi.fn(async () => {
      throw new Error(`Rejected value: ${submittedValue}`);
    });
    const { host } = renderInput({ onRespond });
    const form = host.querySelector("form");
    const input = host.querySelector<HTMLInputElement>("input");

    if (!form || !input) throw new Error("Sensitive input form was not rendered.");
    await act(async () => {
      input.value = submittedValue;
      form.requestSubmit();
    });

    expect(input.value).toBe("");
    expect(host.querySelector("[role='alert']")?.textContent).toBe(
      "Unable to send the response. Please try again.",
    );
    expect(host.textContent).not.toContain(submittedValue);
    expect(document.activeElement).toBe(input);
    expect((host.querySelector("button[type='submit']") as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears an unsubmitted password on unmount", () => {
    const { host, unmount } = renderInput();
    const input = host.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Password input was not rendered.");

    input.value = "unsubmitted-secret-example";
    unmount();

    expect(input.value).toBe("");
    expect(host.textContent).not.toContain("unsubmitted-secret-example");
  });
});
