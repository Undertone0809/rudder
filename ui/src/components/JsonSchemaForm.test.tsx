// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { JsonSchemaForm, type JsonSchemaNode } from "./JsonSchemaForm";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

const nestedArraySchema: JsonSchemaNode = {
  type: "object",
  properties: {
    connections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          headers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                value: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

const nestedArrayValues = {
  connections: [
    {
      headers: [{ value: "a-long-header-value-that-must-not-push-actions-offscreen" }],
    },
  ],
};

function NestedArrayHarness() {
  const [values, setValues] = useState<Record<string, unknown>>(nestedArrayValues);
  return (
    <JsonSchemaForm
      schema={nestedArraySchema}
      values={values}
      onChange={setValues}
    />
  );
}

function renderNestedArrayForm() {
  container = document.createElement("div");
  container.style.width = "390px";
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root!.render(<NestedArrayHarness />);
  });

  return container;
}

describe("JsonSchemaForm responsive arrays", () => {
  it("keeps recursive item content shrinkable and remove actions in the flex row", () => {
    const page = renderNestedArrayForm();
    const removeButtons = Array.from(page.querySelectorAll("button")).filter(
      (button) => button.textContent?.trim() === "Remove item",
    );

    expect(page.firstElementChild?.classList.contains("min-w-0")).toBe(true);
    expect(removeButtons).toHaveLength(2);

    for (const button of removeButtons) {
      const item = button.parentElement;
      const content = item?.firstElementChild;

      expect(button.classList.contains("shrink-0")).toBe(true);
      expect(item?.classList.contains("min-w-0")).toBe(true);
      expect(item?.classList.contains("max-w-full")).toBe(true);
      expect(content?.classList.contains("min-w-0")).toBe(true);
    }

    act(() => removeButtons[0]!.click());

    const remainingRemoveButtons = Array.from(page.querySelectorAll("button")).filter(
      (button) => button.textContent?.trim() === "Remove item",
    );
    expect(remainingRemoveButtons).toHaveLength(1);
  });
});
