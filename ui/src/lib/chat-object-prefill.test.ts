// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildIssueChatPrefill,
  buildIssueChatPrefillHref,
  buildProjectChatPrefill,
  buildProjectChatPrefillHref,
} from "./chat-object-prefill";

describe("chat object prefill", () => {
  it("builds an issue mention from the identifier", () => {
    const prefill = buildIssueChatPrefill({
      id: "issue-123",
      identifier: "RUD-42",
      title: "Fix issue chat",
    });

    expect(prefill).toBe("[@RUD-42](issue://issue-123?r=RUD-42) ");
  });

  it("falls back to the issue title when no identifier exists", () => {
    const prefill = buildIssueChatPrefill({
      id: "issue-123456789",
      identifier: null,
      title: "Fix [chat]\nbutton",
    });

    expect(prefill).toBe("[@Fix chat button](issue://issue-123456789) ");
  });

  it("builds a messenger URL with encoded issue prefill", () => {
    const href = buildIssueChatPrefillHref({
      id: "issue-123",
      identifier: "RUD-42",
      title: "Fix issue chat",
    });

    expect(href).toEqual({
      pathname: "/messenger/chat",
      search: `?prefill=${encodeURIComponent("[@RUD-42](issue://issue-123?r=RUD-42) ")}`,
    });
  });

  it("preserves project mention color metadata", () => {
    const prefill = buildProjectChatPrefill({
      id: "project-123",
      name: "Rudder Dev",
      color: "#ff7a1a",
    });

    expect(prefill).toBe("[@Rudder Dev](project://project-123?c=ff7a1a) ");
  });

  it("builds a messenger URL with encoded project prefill", () => {
    const href = buildProjectChatPrefillHref({
      id: "project-123",
      name: "Rudder Dev",
      color: null,
    });

    expect(href).toEqual({
      pathname: "/messenger/chat",
      search: `?prefill=${encodeURIComponent("[@Rudder Dev](project://project-123) ")}`,
    });
  });
});
