import { waitUntil } from "@vercel/functions";
import type { IncomingMessage, ServerResponse } from "node:http";
import { identityHandler } from "../src/handler.js";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await identityHandler(req, res, { backgroundTaskHandler: waitUntil });
}
