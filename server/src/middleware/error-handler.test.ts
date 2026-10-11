import express from "express";
import { DrizzleQueryError } from "drizzle-orm/errors";
import postgres from "postgres";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "./error-handler.js";

describe("HTTP error handling for unavailable database connections", () => {
  it("maps recognized PostgreSQL transport and server-unavailable errors to generic 503", async () => {
    const app = express();
    app.post("/api/secrets/:id/rotate", (req, _res, next) => {
      if (req.query.kind === "transport") {
        next(Object.assign(new Error("synthetic connection failure"), {
          code: "ECONNREFUSED", errno: "ECONNREFUSED", address: "127.0.0.1", port: 5432,
        }));
        return;
      }
      if (req.query.kind === "wrapped-connection-closed") {
        const driverError = Object.assign(new Error("synthetic driver connection closed"), {
          code: "CONNECTION_CLOSED", errno: "CONNECTION_CLOSED",
          address: ["127.0.0.1"], port: [5432],
        });
        next(new DrizzleQueryError("SELECT 1", [], driverError));
        return;
      }
      if (req.query.kind === "connection-code-spoof") {
        next(Object.assign(new Error("synthetic unrelated error"), { code: "CONNECTION_CLOSED" }));
        return;
      }
      if (req.query.kind === "incomplete-connection-shape") {
        next(Object.assign(new Error("synthetic unrelated error"), {
          code: "CONNECTION_CLOSED", errno: "CONNECTION_CLOSED", address: ["127.0.0.1"],
        }));
        return;
      }
      const error = Object.assign(new Error("synthetic server shutdown"), { code: "57P01" });
      Object.setPrototypeOf(error, postgres.PostgresError.prototype);
      next(error);
    });
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));

    try {
      for (const kind of ["transport", "postgres", "wrapped-connection-closed"] as const) {
        const response = await request(server).post("/api/secrets/id-1/rotate").query({ kind });
        expect(response.status).toBe(503);
        expect(response.body).toEqual({
          error: "Service temporarily unavailable",
          code: "database_unavailable",
        });
        expect(response.text).not.toContain("synthetic connection failure");
        expect(response.text).not.toContain("synthetic server shutdown");
      }

      const spoofed = await request(server).post("/api/secrets/id-1/rotate").query({ kind: "connection-code-spoof" });
      expect(spoofed.status).toBe(500);
      expect(spoofed.body).toEqual({ error: "Internal server error" });

      const incomplete = await request(server).post("/api/secrets/id-1/rotate").query({ kind: "incomplete-connection-shape" });
      expect(incomplete.status).toBe(500);
      expect(incomplete.body).toEqual({ error: "Internal server error" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("keeps ordinary database constraint errors on the normal 500 path", async () => {
    const app = express();
    app.patch("/api/secrets/:id", (req, _res, next) => {
      const error = req.query.kind === "sqlstate-spoof"
        ? Object.assign(new Error("synthetic ordinary error"), { code: "08006" })
        : Object.assign(new Error("synthetic unique violation"), { code: "23505" });
      next(error);
    });
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));

    try {
      for (const kind of ["constraint", "sqlstate-spoof"] as const) {
        const response = await request(server).patch("/api/secrets/id-1").query({ kind });
        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: "Internal server error" });
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("does not relabel unrelated upstream network failures as database failures", async () => {
    const app = express();
    app.post("/api/import/preview", (_req, _res, next) => {
      const networkFailure = Object.assign(new Error("synthetic upstream connection failure"), {
        code: "ECONNRESET", errno: "ECONNRESET", address: "github.example.test", port: 443,
      });
      next(new TypeError("fetch failed", { cause: networkFailure }));
    });
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));

    try {
      const response = await request(server).post("/api/import/preview");
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal server error" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
