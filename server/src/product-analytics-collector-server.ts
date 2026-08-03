import { createDb, type Db } from "@rudderhq/db";
import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import { parseProductAnalyticsCollectorConfig, type ProductAnalyticsCollectorConfig } from "./product-analytics-collector-config.js";
import { productAnalyticsCollectorReportRoutes } from "./routes/product-analytics-collector-report.js";
import { createProductAnalyticsAssertionAuthorizer, productAnalyticsCollectorRoutes } from "./routes/product-analytics-collector.js";
import {
  assertProductAnalyticsCollectorDatabaseBoundary,
  runProductAnalyticsCollectorMaintenance,
} from "./services/product-analytics-collector-maintenance.js";
import { createProductAnalyticsPersistentCollector } from "./services/product-analytics-collector.js";

export type ProductAnalyticsCollectorAppOptions = {
  config: ProductAnalyticsCollectorConfig;
  db: Db;
  maintenanceDb?: Db;
  maintenance?: boolean;
};

export function createProductAnalyticsCollectorApp(options: ProductAnalyticsCollectorAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb", strict: true, type: "application/json" }));
  app.get(["/healthz", "/api/health"], (_req, res) => {
    res.status(200).json({ ok: true, service: "product-analytics-collector", schema: options.config.schema });
  });
  const collector = createProductAnalyticsPersistentCollector(options.db);
  const authorize = createProductAnalyticsAssertionAuthorizer({
    identityPublicKey: options.config.identityPublicKey,
    expectedKeyId: options.config.identityKeyId,
    expectedIssuer: options.config.identityIssuer,
  });
  app.use(productAnalyticsCollectorRoutes(collector, authorize, { revokeSecret: options.config.revokeSecret }));
  // Reports use the maintenance/report connection rather than the ingest
  // connection. In production this URL is provisioned with rollup/report
  // privileges; the collector role never serves raw data to report callers.
  app.use(productAnalyticsCollectorReportRoutes(options.maintenanceDb ?? options.db, {
    reportSecret: options.config.reportSecret,
    privacyThreshold: options.config.privacyThreshold,
  }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "collector_request_failed";
    const details = error && typeof error === "object" ? error as { status?: unknown; type?: unknown } : null;
    if (details?.status === 400 || details?.type === "entity.parse.failed") {
      res.status(400).json({ errorCode: "invalid_schema" });
      return;
    }
    if (message.startsWith("Telemetry assertion") || message.startsWith("Telemetry installation")) {
      res.status(401).json({ errorCode: "unauthorized" });
      return;
    }
    if (message === "request entity too large" || message === "entity.too.large") {
      res.status(413).json({ errorCode: "too_large" });
      return;
    }
    res.status(500).json({ errorCode: "collector_request_failed" });
  });
  if (options.maintenance === true) {
    if (!options.maintenanceDb) {
      throw new Error("product_analytics_maintenance_database_required");
    }
    void runProductAnalyticsCollectorMaintenance(options.maintenanceDb, {
      retentionDays: options.config.retentionDays,
      privacyThreshold: options.config.privacyThreshold,
    }).catch((error) => console.error("[product-analytics-collector] maintenance failed", error));
  }
  return app;
}

export type StartedProductAnalyticsCollector = {
  app: Express;
  server: Server;
  host: string;
  port: number;
  config: ProductAnalyticsCollectorConfig;
  stop(): Promise<void>;
};

export async function startProductAnalyticsCollector(options: {
  config?: ProductAnalyticsCollectorConfig;
  db?: Db;
  listen?: boolean;
} = {}): Promise<StartedProductAnalyticsCollector> {
  const config = options.config ?? parseProductAnalyticsCollectorConfig();
  const db = options.db ?? createDb(config.databaseUrl);
  const maintenanceDb = options.db ? options.db : createDb(config.maintenanceDatabaseUrl);
  await assertProductAnalyticsCollectorDatabaseBoundary(db, config.expectedDatabaseRole);
  await assertProductAnalyticsCollectorDatabaseBoundary(maintenanceDb, options.db ? config.expectedDatabaseRole : config.maintenanceDatabaseRole);
  // Project once before accepting traffic so a restart cannot expose stale
  // rollups or leave retention cleanup waiting for the first interval tick.
  await runProductAnalyticsCollectorMaintenance(maintenanceDb, {
    retentionDays: config.retentionDays,
    privacyThreshold: config.privacyThreshold,
  });
  const app = createProductAnalyticsCollectorApp({ config, db, maintenanceDb, maintenance: false });
  const server = createServer(app);
  if (options.listen !== false) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(config.port, config.host);
    });
  }
  const interval = setInterval(() => {
    void runProductAnalyticsCollectorMaintenance(maintenanceDb, {
      retentionDays: config.retentionDays,
      privacyThreshold: config.privacyThreshold,
    }).catch((error) => console.error("[product-analytics-collector] maintenance failed", error));
  }, config.rollupIntervalMs);
  interval.unref?.();
  return {
    app,
    server,
    host: config.host,
    port: config.port,
    config,
    async stop() {
      clearInterval(interval);
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
      const closableDb = db as Db & { $client?: { end?: (options?: { timeout?: number }) => Promise<void> } };
      await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
      if (maintenanceDb !== db) {
        const closableMaintenanceDb = maintenanceDb as Db & { $client?: { end?: (options?: { timeout?: number }) => Promise<void> } };
        await closableMaintenanceDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
      }
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startProductAnalyticsCollector().then((started) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try {
        await started.stop();
      } finally {
        process.exit(0);
      }
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }).catch((error) => {
    console.error("[product-analytics-collector] startup failed", error);
    process.exitCode = 1;
  });
}
