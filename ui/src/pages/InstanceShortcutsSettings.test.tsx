// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InstanceShortcutsSettings } from "./InstanceShortcutsSettings";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { shortcuts: [] },
    isLoading: false,
    error: null,
  }),
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: {
    getShortcuts: vi.fn(),
    updateShortcuts: vi.fn(),
  },
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        "common.systemSettings": "System settings",
        "common.shortcuts": "Shortcuts",
      };
      return messages[key] ?? key;
    },
  }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

describe("InstanceShortcutsSettings", () => {
  it("shows the Escape system shortcut as read-only without entering capture mode", () => {
    const html = renderToStaticMarkup(<InstanceShortcutsSettings />);

    expect(html).toContain("Navigate back / close detail");
    expect(html).toContain("Read-only");
    expect(html).not.toContain("Press a shortcut. Escape cancels capture.");
  });
});
