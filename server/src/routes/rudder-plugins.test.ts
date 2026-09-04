import type { Request, Response } from "express";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createRequestAbortGuard } from "./rudder-plugins.js";

function createEventSources() {
  return {
    req: new EventEmitter() as Request,
    res: new EventEmitter() as Response,
  };
}

describe("createRequestAbortGuard", () => {
  it("ignores request close after the body has completed", () => {
    const { req, res } = createEventSources();
    const guard = createRequestAbortGuard(req, res);

    req.emit("close");

    expect(guard.signal.aborted).toBe(false);
    guard.dispose();
  });

  it("aborts when the response closes after request body completion", () => {
    const { req, res } = createEventSources();
    const guard = createRequestAbortGuard(req, res);

    res.emit("close");

    expect(guard.signal.aborted).toBe(true);
    guard.dispose();
  });

  it("aborts when the request body is interrupted", () => {
    const { req, res } = createEventSources();
    const guard = createRequestAbortGuard(req, res);

    req.emit("aborted");

    expect(guard.signal.aborted).toBe(true);
    guard.dispose();
  });

  it("removes request and response listeners on disposal", () => {
    const { req, res } = createEventSources();
    const guard = createRequestAbortGuard(req, res);

    expect(req.listenerCount("aborted")).toBe(1);
    expect(res.listenerCount("close")).toBe(1);

    guard.dispose();

    expect(req.listenerCount("aborted")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
  });
});
