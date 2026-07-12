import { describe, expect, it } from "vitest";
import { isPostgresError } from "../services/postgres-errors.js";

describe("isPostgresError", () => {
  it("matches direct and ORM-wrapped PostgreSQL errors", () => {
    expect(isPostgresError({ code: "23505" }, "23505")).toBe(true);
    expect(isPostgresError({
      cause: {
        code: "23505",
        constraint_name: "organizations_issue_prefix_idx",
      },
    }, "23505", "organizations_issue_prefix_idx")).toBe(true);
    expect(isPostgresError({ cause: { code: "22P02" } }, "22P02")).toBe(true);
  });

  it("accepts both driver constraint fields and a message fallback", () => {
    expect(isPostgresError({
      code: "23505",
      constraint: "heartbeat_runs_active_chat_conversation_uq",
    }, "23505", "heartbeat_runs_active_chat_conversation_uq")).toBe(true);
    expect(isPostgresError({
      code: "23505",
      message: "duplicate heartbeat_runs_active_chat_conversation_uq",
    }, "23505", "heartbeat_runs_active_chat_conversation_uq")).toBe(true);
  });

  it("rejects unrelated codes and constraints", () => {
    expect(isPostgresError({ code: "23503" }, "23505")).toBe(false);
    expect(isPostgresError({
      cause: { code: "23505", constraint_name: "some_other_constraint" },
    }, "23505", "organizations_issue_prefix_idx")).toBe(false);
    expect(isPostgresError({
      code: "23505",
      constraint: "some_other_constraint",
      message: "duplicate organizations_issue_prefix_idx",
    }, "23505", "organizations_issue_prefix_idx")).toBe(false);
    expect(isPostgresError({
      code: "23505",
      constraint_name: "some_other_constraint",
      message: "duplicate organizations_issue_prefix_idx",
    }, "23505", "organizations_issue_prefix_idx")).toBe(false);
  });

  it("stops safely on cyclic and excessively deep cause chains", () => {
    const cyclic: { code?: string; cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isPostgresError(cyclic, "23505")).toBe(false);

    const target = { code: "23505" };
    let wrapped: { cause: unknown } = { cause: target };
    for (let depth = 0; depth < 8; depth += 1) wrapped = { cause: wrapped };
    expect(isPostgresError(wrapped, "23505")).toBe(false);
  });
});
