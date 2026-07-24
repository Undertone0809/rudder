import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/client";
import { Router, type Request } from "express";
import { HttpError } from "../errors.js";
import { markHttpRequestBodySensitive } from "../middleware/logger.js";
import { ManagedMcpClientError } from "../services/mcp/managed-client.js";
import {
  managedMcpRuntimeService,
  type ManagedMcpRuntimeIdentity,
} from "../services/mcp/managed-runtime.js";

type RuntimeService = Pick<
  ReturnType<typeof managedMcpRuntimeService>,
  "requireBindingAccess" | "listTools" | "callTool"
>;

type JsonRpcId = string | number | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requestIdentity(req: Request): ManagedMcpRuntimeIdentity | null {
  if (
    req.actor.type !== "agent"
    || req.actor.source !== "agent_jwt"
    || !req.actor.orgId
    || !req.actor.agentId
    || !req.actor.runId
  ) {
    return null;
  }
  return {
    orgId: req.actor.orgId,
    agentId: req.actor.agentId,
    runId: req.actor.runId,
  };
}

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: Record<string, unknown>,
) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  };
}

function safeManagedCode(code: string): string {
  return /^[a-z0-9_]{1,80}$/u.test(code) ? code : "mcp_tool_failed";
}

export function managedMcpRuntimeRoutes(runtime: RuntimeService) {
  const router = Router();

  router.use("/mcp/runtime/bindings", (req, _res, next) => {
    markHttpRequestBodySensitive(req);
    next();
  });

  router.post("/mcp/runtime/bindings/:bindingId", async (req, res) => {
    const identity = requestIdentity(req);
    if (!identity) {
      res.status(403).json({ error: "Signed agent run authentication required" });
      return;
    }
    const bindingId = req.params.bindingId as string;
    const body = req.body;
    if (
      !isRecord(body)
      || body.jsonrpc !== "2.0"
      || typeof body.method !== "string"
      || (
        "id" in body
        && body.id !== null
        && typeof body.id !== "string"
        && typeof body.id !== "number"
      )
    ) {
      res.status(400).json(jsonRpcError(null, -32600, "Invalid Request"));
      return;
    }
    const id = ("id" in body ? body.id : null) as JsonRpcId;
    const params = isRecord(body.params) ? body.params : {};

    try {
      if (body.method === "notifications/initialized") {
        await runtime.requireBindingAccess(identity, bindingId);
        res.status(202).end();
        return;
      }
      if (body.method === "initialize") {
        await runtime.requireBindingAccess(identity, bindingId);
        const requestedProtocolVersion =
          typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : null;
        const protocolVersion = requestedProtocolVersion
          && SUPPORTED_PROTOCOL_VERSIONS.includes(requestedProtocolVersion)
          ? requestedProtocolVersion
          : LATEST_PROTOCOL_VERSION;
        res.set("MCP-Protocol-Version", protocolVersion);
        res.json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: "rudder-managed-mcp-proxy",
              version: "1.0.0",
            },
          },
        });
        return;
      }
      if (body.method === "ping") {
        await runtime.requireBindingAccess(identity, bindingId);
        res.json({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      if (body.method === "tools/list") {
        res.json({
          jsonrpc: "2.0",
          id,
          result: { tools: await runtime.listTools(identity, bindingId) },
        });
        return;
      }
      if (body.method === "tools/call") {
        if (
          typeof params.name !== "string"
          || (
            params.arguments !== undefined
            && !isRecord(params.arguments)
          )
        ) {
          res.json(jsonRpcError(id, -32602, "Invalid params"));
          return;
        }
        const result = await runtime.callTool(
          identity,
          bindingId,
          params.name,
          (params.arguments ?? {}) as Record<string, unknown>,
        );
        res.json({ jsonrpc: "2.0", id, result });
        return;
      }
      if (!("id" in body)) {
        await runtime.requireBindingAccess(identity, bindingId);
        res.status(202).end();
        return;
      }
      res.json(jsonRpcError(id, -32601, "Method not found"));
    } catch (error) {
      if (error instanceof ManagedMcpClientError) {
        res.json(jsonRpcError(
          id,
          -32002,
          "Managed MCP tool call failed",
          { code: safeManagedCode(error.code) },
        ));
        return;
      }
      if (error instanceof HttpError) {
        res.json(jsonRpcError(
          id,
          -32001,
          "Managed MCP request is not authorized",
        ));
        return;
      }
      res.json(jsonRpcError(id, -32603, "Internal error"));
    }
  });

  router.delete("/mcp/runtime/bindings/:bindingId", (req, res) => {
    if (!requestIdentity(req)) {
      res.status(403).json({ error: "Signed agent run authentication required" });
      return;
    }
    res.status(200).end();
  });

  router.get("/mcp/runtime/bindings/:bindingId", (_req, res) => {
    res.status(405).set("Allow", "POST, DELETE").end();
  });

  return router;
}
