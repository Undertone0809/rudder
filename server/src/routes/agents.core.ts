/** Agent contracts owned by Rust. This adapter relays authenticated facts and
 * exact request/query values; it performs no domain lookup, mutation or fallback. */
import { Router, type Request, type Response } from "express";
import { homedir } from "node:os";
import { resolveOrganizationAgentsDir } from "../home-paths.js";
import type { RustFoundationBridge, RustFoundationResponse } from "../services/rust-foundation-bridge.js";
export function agentCoreRoutes(bridge: RustFoundationBridge | undefined, _deploymentMode: string) {
    const router = Router();
    const reply = (res: Response, value: RustFoundationResponse) => res.status(value.status).set("content-type", value.contentType).send(value.body);
    const forward = (operation: string) => async (req: Request, res: Response) => {
        if (!bridge?.agentCore) {
            res.status(503).json({ error: "Rust Agent core is unavailable", code: "rust_foundation_agent_core_unavailable" });
            return;
        }
        const command = { operation, orgId: req.params.orgId ?? null, id: req.params.id ?? null,
            revisionId: req.params.revisionId ?? null, keyId: req.params.keyId ?? null,
            query: req.query, input: req.body, homeDirectory: homedir(), processWorkingDirectory: process.cwd() };
        try {
            if (["list", "configurations", "name-suggestion", "inbox", "scheduler-heartbeats", "keys", "key-revoke"].includes(operation)) {
                reply(res, await bridge.agentCore(req.actor, command));
                return;
            }
            const resolved = await bridge.agentCore(req.actor, { ...command, resolveOnly: true });
            if (resolved.status !== 200) {
                reply(res, resolved);
                return;
            }
            const target = JSON.parse(resolved.body.toString()) as {
                orgId: string;
                id: string | null;
            };
            // Filesystem placement is a signed host fact for Rust's selected target.
            reply(res, await bridge.agentCore(req.actor, { ...command, id: target.id,
                organizationAgentsRoot: resolveOrganizationAgentsDir(target.orgId) }));
        }
        catch {
            res.status(503).json({ error: "Rust Agent core is unavailable", code: "rust_foundation_agent_core_request_failed" });
        }
    };
    router.get("/orgs/:orgId/agents", forward("list"));
    router.get("/orgs/:orgId/agent-configurations", forward("configurations"));
    router.get("/orgs/:orgId/agents/name-suggestion", forward("name-suggestion"));
    router.get("/agents/me/inbox-lite", forward("inbox"));
    router.get("/agents/:id/configuration", forward("configuration"));
    router.get("/agents/:id/config-revisions", forward("revisions"));
    router.get("/agents/:id/config-revisions/:revisionId", forward("revision"));
    router.post("/agents/:id/config-revisions/:revisionId/rollback", forward("rollback"));
    router.get("/agents/:id/keys", forward("keys"));
    router.post("/agents/:id/keys", forward("key-create"));
    router.delete("/agents/:id/keys/:keyId", forward("key-revoke"));
    router.get("/agents/:id/runtime-state", forward("runtime-state"));
    router.post("/agents/:id/runtime-state/reset-session", forward("reset-session"));
    router.get("/agents/:id/task-sessions", forward("task-sessions"));
    router.get("/instance/scheduler-heartbeats", forward("scheduler-heartbeats"));
    return router;
}
