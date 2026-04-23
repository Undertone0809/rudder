import express, { type Express, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./lib/config.js";
import { RunIntelligenceCache, type CachedRunDetail, type CachedRunSummary } from "./lib/cache.js";
import { RunIntelligenceSync } from "./lib/sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface RunIntelligenceAppDeps {
  cache: Pick<RunIntelligenceCache, "getOrganizations" | "listRuns" | "readRunDetail">;
  sync: Pick<RunIntelligenceSync, "refreshRunDetail" | "synchronizeAll">;
  publicDir?: string;
}

function resolvePublicDir() {
  const candidates = [
    path.join(__dirname, "public"),
    path.join(__dirname, "..", "src", "public"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return candidates[0];
}

export function createRunIntelligenceApp({ cache, sync, publicDir = resolvePublicDir() }: RunIntelligenceAppDeps): Express {
  const app = express();

  app.use(express.json());
  app.use(express.static(publicDir));

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ ok: true, publicDir });
  });

  app.get("/api/organizations", (_req: Request, res: Response) => {
    res.json(cache.getOrganizations());
  });

  app.get("/api/runs", (_req: Request, res: Response) => {
    res.json(cache.listRuns());
  });

  app.post("/api/refresh", async (_req: Request, res: Response) => {
    await sync.synchronizeAll();
    res.json({
      ok: true,
      runs: cache.listRuns().length,
      refreshedAt: new Date().toISOString(),
    });
  });

  app.get("/api/runs/:runId", async (req: Request, res: Response) => {
    const runId = req.params.runId as string;
    const cached = await cache.readRunDetail(runId);
    if (cached) {
      res.json(cached);
      return;
    }

    const refreshed = await sync.refreshRunDetail(runId);
    res.json({
      detail: refreshed.detail,
      diagnosis: refreshed.diagnosis,
      trace: refreshed.trace,
      lastSyncedAt: new Date().toISOString(),
    } satisfies CachedRunDetail);
  });

  app.post("/api/runs/:runId/refresh", async (req: Request, res: Response) => {
    const runId = req.params.runId as string;
    const refreshed = await sync.refreshRunDetail(runId);
    res.json({
      detail: refreshed.detail,
      diagnosis: refreshed.diagnosis,
      trace: refreshed.trace,
      lastSyncedAt: new Date().toISOString(),
    } satisfies CachedRunDetail);
  });

  app.get(/.*/, (_req: Request, res: Response) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  return app;
}

async function main() {
  const config = getConfig();
  const cache = new RunIntelligenceCache(config.cacheDir);
  await cache.init();

  const sync = new RunIntelligenceSync(cache, config.rudderApiUrl, config.syncIntervalMs);
  await sync.start();

  const app = createRunIntelligenceApp({ cache, sync });
  const server = app.listen(config.port, () => {
    console.log(`Run Intelligence listening on http://localhost:${config.port}`);
  });

  const shutdown = () => {
    sync.stop();
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main();
}

export type { CachedRunDetail, CachedRunSummary };
