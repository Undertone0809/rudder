import "express-serve-static-core";
import type { Buffer } from "node:buffer";

type BoardActorSource = "local_implicit" | "session" | "board_key";
type AgentActorSource = "agent_key" | "agent_jwt";

type RequestActor = {
  type: "none" | "board" | "agent";
  source: "none" | BoardActorSource | AgentActorSource;
  userId?: string | undefined;
  orgIds?: string[] | undefined;
  orgId?: string | undefined;
  companyIds?: string[] | undefined;
  isInstanceAdmin?: boolean | undefined;
  agentId?: string | undefined;
  companyId?: string | undefined;
  keyId?: string | undefined;
  runId?: string | undefined;
};

declare global {
  namespace Express {
    interface Request {
      actor: RequestActor;
      rawBody?: Buffer;
    }
  }
}

declare module "express-serve-static-core" {
  interface Request {
    actor: RequestActor;
    rawBody?: Buffer;
  }
}
