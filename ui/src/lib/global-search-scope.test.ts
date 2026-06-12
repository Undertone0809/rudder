import { describe, expect, it } from "vitest";
import {
  getGlobalSearchScopeForAlias,
  getPendingGlobalSearchScopeSuggestion,
  parseGlobalSearchQuery,
  shouldConfirmGlobalSearchScopeFromKey,
  shouldConfirmGlobalSearchScopeFromValue,
} from "./global-search-scope";

describe("global search scope parsing", () => {
  it("maps supported aliases to scopes", () => {
    expect(getGlobalSearchScopeForAlias("issue")).toBe("issue");
    expect(getGlobalSearchScopeForAlias("issues")).toBe("issue");
    expect(getGlobalSearchScopeForAlias("library")).toBe("library");
    expect(getGlobalSearchScopeForAlias("docs")).toBe("library");
    expect(getGlobalSearchScopeForAlias("doc")).toBe("library");
    expect(getGlobalSearchScopeForAlias("chat")).toBe("chat");
    expect(getGlobalSearchScopeForAlias("agents")).toBe("agent");
    expect(getGlobalSearchScopeForAlias("projects")).toBe("project");
  });

  it("suggests a scope only for an unconfirmed alias prefix", () => {
    expect(getPendingGlobalSearchScopeSuggestion("iss")).toBe("issue");
    expect(getPendingGlobalSearchScopeSuggestion("lib")).toBe("library");
    expect(getPendingGlobalSearchScopeSuggestion("issue")).toBeNull();
    expect(getPendingGlobalSearchScopeSuggestion("library notes")).toBeNull();
    expect(getPendingGlobalSearchScopeSuggestion("rare token")).toBeNull();
  });

  it("confirms a scope from Space, Tab, or Enter when the value is exactly an alias", () => {
    expect(shouldConfirmGlobalSearchScopeFromKey(" ", "issue")).toBe("issue");
    expect(shouldConfirmGlobalSearchScopeFromKey("Tab", "library")).toBe("library");
    expect(shouldConfirmGlobalSearchScopeFromKey("Enter", "docs")).toBe("library");
    expect(shouldConfirmGlobalSearchScopeFromKey(" ", "iss")).toBeNull();
    expect(shouldConfirmGlobalSearchScopeFromKey(" ", "library notes")).toBeNull();
  });

  it("confirms a pasted or filled alias with trailing whitespace", () => {
    expect(shouldConfirmGlobalSearchScopeFromValue("issue ")).toBe("issue");
    expect(shouldConfirmGlobalSearchScopeFromValue("library ")).toBe("library");
    expect(shouldConfirmGlobalSearchScopeFromValue("library notes ")).toBeNull();
  });

  it("keeps scoped query state separate from prefix suggestions", () => {
    expect(parseGlobalSearchQuery("iss")).toEqual({
      scope: null,
      query: "iss",
      pendingScopeSuggestion: "issue",
    });
    expect(parseGlobalSearchQuery("status icon", "issue")).toEqual({
      scope: "issue",
      query: "status icon",
      pendingScopeSuggestion: null,
    });
  });
});
