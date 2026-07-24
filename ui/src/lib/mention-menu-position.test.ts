import { describe, expect, it } from "vitest";
import {
  getMentionMenuPositionForViewport,
  getMentionPanelPositionForViewport,
} from "./mention-menu-position";

describe("getMentionMenuPositionForViewport", () => {
  it("opens upward before crossing the editor boundary", () => {
    const position = getMentionMenuPositionForViewport(
      {
        viewportTop: 500,
        viewportBottom: 520,
        viewportLeft: 300,
      },
      1280,
      900,
      { boundaryBottom: 560 },
    );

    expect(position).toMatchObject({
      left: 300,
      width: 520,
      bottom: 404,
      maxHeight: 200,
    });
    expect("top" in position).toBe(false);
  });
});

describe("getMentionPanelPositionForViewport", () => {
  it("caps a wide document-surface panel without moving it outside the viewport", () => {
    const position = getMentionPanelPositionForViewport(
      {
        viewportTop: 120,
        viewportBottom: 192,
        viewportLeft: 420,
        viewportRight: 1180,
      },
      1280,
      720,
      { maxWidth: 520 },
    );

    expect(position).toMatchObject({
      left: 420,
      width: 520,
      top: 202,
      maxHeight: 360,
    });
  });

  it("keeps a narrow document-surface panel aligned to its container", () => {
    const position = getMentionPanelPositionForViewport(
      {
        viewportTop: 120,
        viewportBottom: 192,
        viewportLeft: 24,
        viewportRight: 364,
      },
      1280,
      720,
      { maxWidth: 520 },
    );

    expect(position).toMatchObject({
      left: 24,
      width: 340,
      top: 202,
      maxHeight: 360,
    });
  });
});
