import type { Db } from "@rudderhq/db";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { actorMiddleware } from "../middleware/auth.js";
import {
  errorHandler,
  httpLogger,
  markBrowserHttpRequestBodySensitive,
} from "../middleware/index.js";
import { logger } from "../middleware/logger.js";
import { privateHostnameGuard, resolvePrivateHostnameAllowSet } from "../middleware/private-hostname-guard.js";
import { createChatBackgroundRuntime } from "../routes/chat-background-runtime.js";
import { llmRoutes } from "../routes/llms.js";
import { pluginUiStaticRoutes } from "../routes/plugin-ui-static.js";
import { DEFAULT_LOCAL_PLUGIN_DIR } from "../services/plugin-loader.js";
import { workspaceWebPreviewRuntime } from "../services/workspace-web-preview.js";
import { applyUiBranding } from "../ui-branding.js";
import type { PluginHostRuntime } from "./plugin-host-runtime.js";
import { registerApiRoutes } from "./register-api-routes.js";
import type { RudderAppOptions } from "./types.js";

export interface HttpAppHandle {
  app: express.Express;
  close(): Promise<void>;
}

export function resolveViteHmrPort(serverPort: number): number {
  if (serverPort <= 55_535) {
    return serverPort + 10_000;
  }
  return Math.max(1_024, serverPort - 10_000);
}

export async function createHttpApp(
  db: Db,
  opts: RudderAppOptions,
  pluginRuntime: PluginHostRuntime,
): Promise<HttpAppHandle> {
  const app = express();
  const previewOrigin = opts.workspacePreviewOrigin ?? `http://preview.localhost:${opts.serverPort}`;
  const workspacePreview = workspaceWebPreviewRuntime(db, {
    previewOrigin,
    requireLoopbackParent: !opts.workspacePreviewOrigin,
  });
  const chatBackgroundRuntime = createChatBackgroundRuntime();
  let closeVite: (() => Promise<void>) | null = null;
  let closeInFlight: Promise<void> | null = null;
  const close = () => {
    if (closeInFlight) return closeInFlight;
    closeInFlight = Promise.resolve().then(async () => {
      const disposeVite = closeVite;
      closeVite = null;
      const results = await Promise.allSettled([
        Promise.resolve().then(() => chatBackgroundRuntime.close()),
        Promise.resolve().then(() => disposeVite?.()),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "HTTP app cleanup failed");
    });
    return closeInFlight;
  };
  const rollbackStartup = async (startupError: unknown): Promise<never> => {
    try {
      await close();
    } catch (cleanupError) {
      logger.error({ err: cleanupError, startupError }, "HTTP app startup rollback failed");
    }
    throw startupError;
  };
  const privateHostnameGateEnabled =
    opts.deploymentMode === "authenticated" && opts.deploymentExposure === "private";
  const privateHostnameAllowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });

  // Preview capabilities are bearer secrets, so this Host-only branch runs
  // before the ordinary request logger and never mounts Rudder API/UI routes.
  app.use(async (req, res, next) => {
    if (await workspacePreview.handlePreviewHostRequest(req, res)) return;
    next();
  });
  app.use("/workspace-preview", (_req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });

  app.use(express.json({
    // Organization import/export payloads can inline full portable packages.
    limit: "10mb",
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));
  app.use(markBrowserHttpRequestBodySensitive);
  app.use(httpLogger);
  app.use(
    privateHostnameGuard({
      enabled: privateHostnameGateEnabled,
      allowedHostnames: opts.allowedHostnames,
      bindHost: opts.bindHost,
    }),
  );
  app.use(
    actorMiddleware(db, {
      deploymentMode: opts.deploymentMode,
      resolveSession: opts.resolveSession,
    }),
  );
  app.get("/api/auth/get-session", (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.json({
      session: {
        id: `rudder:${req.actor.source}:${req.actor.userId}`,
        userId: req.actor.userId,
      },
      user: {
        id: req.actor.userId,
        email: null,
        name: req.actor.source === "local_implicit" ? "Local Board" : null,
      },
    });
  });
  if (opts.betterAuthHandler) {
    app.all("/api/auth/*authPath", opts.betterAuthHandler);
  }
  app.use(llmRoutes(db));
  try {
    app.use(
      "/api",
      registerApiRoutes(db, opts, pluginRuntime, workspacePreview, chatBackgroundRuntime),
    );
  } catch (error) {
    return rollbackStartup(error);
  }
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });
  try {
    app.use(pluginUiStaticRoutes(db, {
      localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR,
    }));
  } catch (error) {
    return rollbackStartup(error);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  if (opts.uiMode === "static") {
    try {
      const candidates = [
        path.resolve(__dirname, "../../ui-dist"),
        path.resolve(__dirname, "../../../ui/dist"),
      ];
      const uiDist = candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html")));
      if (uiDist) {
        const indexHtml = applyUiBranding(fs.readFileSync(path.join(uiDist, "index.html"), "utf-8"));
        app.use(express.static(uiDist));
        app.get(/.*/, (_req, res) => {
          res.status(200).set("Content-Type", "text/html").end(indexHtml);
        });
      } else {
        console.warn("[rudder] UI dist not found; running in API-only mode");
      }
    } catch (error) {
      return rollbackStartup(error);
    }
  }

  if (opts.uiMode === "vite-dev") {
    try {
      const uiRoot = path.resolve(__dirname, "../../../ui");
      const hmrPort = resolveViteHmrPort(opts.serverPort);
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        root: uiRoot,
        appType: "custom",
        server: {
          middlewareMode: true,
          hmr: {
            host: opts.bindHost,
            port: hmrPort,
            clientPort: hmrPort,
          },
          allowedHosts: privateHostnameGateEnabled ? Array.from(privateHostnameAllowSet) : undefined,
        },
      });
      closeVite = () => vite.close();

      app.use(vite.middlewares);
      app.get(/.*/, async (req, res, next) => {
        try {
          const templatePath = path.resolve(uiRoot, "index.html");
          const template = fs.readFileSync(templatePath, "utf-8");
          const html = applyUiBranding(await vite.transformIndexHtml(req.originalUrl, template));
          res.status(200).set({ "Content-Type": "text/html" }).end(html);
        } catch (err) {
          next(err);
        }
      });
    } catch (error) {
      return rollbackStartup(error);
    }
  }

  try {
    app.use(errorHandler);
    return { app, close };
  } catch (error) {
    return rollbackStartup(error);
  }
}
