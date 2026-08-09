import { describe, expect, it } from "vitest";

import {
  _createJsxRuntimeElementForTests,
} from "./slots";

describe("plugin JSX runtime bridge", () => {
  it("passes JSX children as separate createElement arguments", () => {
    const react = {
      createElement: (...args: unknown[]) => args,
    };
    const withKey = (props: Record<string, unknown> | null | undefined, key: string | number | undefined) => ({
      ...(props ?? {}),
      ...(key === undefined ? {} : { key }),
    });
    const firstChild = { type: "first" };
    const secondChild = { type: "second" };

    expect(_createJsxRuntimeElementForTests(
      react,
      withKey,
      "section",
      { className: "stack", children: [firstChild, secondChild] },
      "slot-key",
    )).toEqual([
      "section",
      { className: "stack", key: "slot-key" },
      firstChild,
      secondChild,
    ]);
  });

  it("keeps a scalar child on props", () => {
    const react = {
      createElement: (...args: unknown[]) => args,
    };
    const withKey = (props: Record<string, unknown> | null | undefined, _key: string | number | undefined) => props ?? {};

    expect(_createJsxRuntimeElementForTests(
      react,
      withKey,
      "span",
      { children: "text" },
      undefined,
    )).toEqual(["span", { children: "text" }]);
  });
});
