// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssigneeLabel, AssigneeSelfActionLabel } from "./AssigneeLabel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AssigneeLabel current user avatar", () => {
  it("renders the supplied user avatar while retaining fallback content", () => {
    const html = renderToStaticMarkup(
      <AssigneeLabel kind="user" label="Me" avatarUrl="https://example.test/me.png" />,
    );

    expect(html).toContain('data-avatar-url="https://example.test/me.png"');
    expect(html).toContain('data-slot="avatar-fallback"');
  });

  it("keeps the existing fallback when no avatar is available", () => {
    const html = renderToStaticMarkup(<AssigneeSelfActionLabel />);

    expect(html).not.toContain("data-avatar-url");
    expect(html).toContain('data-slot="avatar-fallback"');
    expect(html).toContain("Assign to me");
  });

  it("keeps fallback content available when the avatar image fails", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => root.render(<AssigneeLabel kind="user" label="Me" avatarUrl="https://invalid.test/me.png" />));
    const image = container.querySelector("img");
    act(() => image?.dispatchEvent(new Event("error")));

    expect(container.querySelector('[data-slot="avatar-fallback"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="avatar"]')?.getAttribute("data-avatar-url")).toBe("https://invalid.test/me.png");
    act(() => root.unmount());
    container.remove();
  });
});
