import { describe, expect, it } from "vitest";
import { formatDisplayPath, formatShortUuid } from "./display-path";

describe("display path formatting", () => {
  it("formats UUIDs using the Rudder short ID shape", () => {
    expect(formatShortUuid("87e2f140-3876-4d47-b1e0-71d1bcd772ac")).toBe("87e2f1403876");
  });

  it("shortens UUID path segments without changing surrounding path text", () => {
    expect(
      formatDisplayPath(
        "/Users/zeeland/.rudder/instances/default/organizations/87e2f140-3876-4d47-b1e0-71d1bcd772ac",
      ),
    ).toBe("/Users/zeeland/.rudder/instances/default/organizations/87e2f1403876");
  });

  it("shortens every visible UUID in a path-like string", () => {
    expect(
      formatDisplayPath(
        "/tmp/runs/021814b8-6691-4351-a286-ad33caec1272/logs/b3c85ce0-d7b4-407d-b071-478d6e2d337d.txt",
      ),
    ).toBe("/tmp/runs/021814b86691/logs/b3c85ce0d7b4.txt");
  });
});
