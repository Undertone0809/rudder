import type { Db } from "@rudderhq/db";
import { externalUserBindings } from "@rudderhq/db";
import { localOfflineGrantSchema, localServerExchangeSchema } from "@rudderhq/shared";
import { and, eq } from "drizzle-orm";
import { Router } from "express";
import { forbidden, unauthorized } from "../errors.js";
import {
  localAccountAuthService,
  type LocalAccountExchangePolicy,
} from "../services/local-account-auth.js";
import type { LocalAccountSessionRevocation } from "../services/local-account-session-revocation.js";

export function localAccountAuthRoutes(
  db: Db,
  options: {
    installationId: string;
    exchangePolicy: LocalAccountExchangePolicy;
    sessionRevocation?: LocalAccountSessionRevocation;
  },
) {
  const router = Router();
  const service = localAccountAuthService(db, options.exchangePolicy);

  router.post("/auth/local-exchange", async (req, res) => {
    const input = localServerExchangeSchema.parse(req.body);
    const result = await service.redeem(input.exchangeCode);
    res.setHeader("Set-Cookie", result.session.setCookie);
    res.status(200).json({
      userId: result.userId,
      session: {
        id: result.session.id,
        expiresAt: result.session.expiresAt.toISOString(),
      },
    });
  });

  router.post("/auth/local-offline", async (req, res) => {
    const input = localOfflineGrantSchema.parse(req.body);
    const result = await service.redeemOffline(input);
    res.setHeader("Set-Cookie", result.session.setCookie);
    res.status(200).json({
      userId: result.userId,
      nextTrustedTimeMs: result.nextTrustedTimeMs,
      session: {
        id: result.session.id,
        expiresAt: result.session.expiresAt.toISOString(),
      },
    });
  });

  router.post("/auth/local-claim", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("A local Rudder user session is required");
    }
    const binding = await db
      .select({
        issuer: externalUserBindings.issuer,
        subject: externalUserBindings.subject,
      })
      .from(externalUserBindings)
      .where(
        and(
          eq(externalUserBindings.localUserId, req.actor.userId),
          eq(externalUserBindings.issuer, options.exchangePolicy.expectedIssuer.replace(/\/+$/, "")),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!binding) throw forbidden("The current local user is not bound to a Rudder Account");

    const result = await service.claimLegacyInstallation({
      installationId: options.installationId,
      issuer: binding.issuer,
      subject: binding.subject,
      localUserId: req.actor.userId,
    });
    res.status(200).json(result);
  });

  router.post("/auth/local-signout-all", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("A local Rudder user session is required");
    }
    const result = await service.revokeAllSessions(req.actor.userId);
    options.sessionRevocation?.publish(req.actor.userId);
    res.status(200).json(result);
  });

  return router;
}
