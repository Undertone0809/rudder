import * as lark from "@larksuiteoapi/node-sdk";
import { randomUUID } from "node:crypto";

import type {
  AgentIntegrationProviderRegion,
  AgentIntegrationSetupSession,
  AgentIntegrationSummary,
} from "@rudderhq/shared";

const DEFAULT_EXPIRE_SECONDS = 600;
const DEFAULT_REGISTRATION_SOURCE = "rudder/agent-integrations";
const DEFAULT_FEISHU_DOMAIN = "accounts.feishu.cn";
const DEFAULT_LARK_DOMAIN = "accounts.larksuite.com";
const FEISHU_AGENT_APP_TENANT_SCOPES = [
  "application:application:self_manage",
  "application:bot.menu:readonly",
  "application:bot.menu:write",
  "application:app_slash_command:read",
  "application:app_slash_command:write",
  "im:message:send_as_bot",
  "im:message.reactions:write_only",
];

export interface FeishuAppRegistrationResult {
  appId: string;
  appSecret: string;
  installerUserId: string | null;
  installerUnionId: string | null;
}

export interface FeishuAppRegistrar {
  register(input: {
    providerRegion: AgentIntegrationProviderRegion;
    suggestedBotName: string;
    source: string;
    signal: AbortSignal;
    onSetupUrl: (info: { setupUrl: string; expireInSeconds: number }) => void;
    onStatusChange: (detail: string) => void;
  }): Promise<FeishuAppRegistrationResult>;
}

type SetupSessionStatus = AgentIntegrationSetupSession["status"];

interface FeishuAppRegistrationSessionState {
  id: string;
  orgId: string;
  agentId: string;
  providerRegion: AgentIntegrationProviderRegion;
  suggestedBotName: string;
  setupUrl: string;
  status: SetupSessionStatus;
  statusDetail: string | null;
  expiresAt: Date | null;
  integration: AgentIntegrationSummary | null;
  result: FeishuAppRegistrationResult | null;
  abortController: AbortController;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

function normalizeError(error: unknown) {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : null;
    const description = typeof record.description === "string" ? record.description : null;
    const message = error instanceof Error ? error.message : null;
    return [code, description ?? message].filter(Boolean).join(": ") || "Feishu app registration failed";
  }
  return error ? String(error) : "Feishu app registration failed";
}

function installerUnionIdFromUserInfo(userInfo: unknown) {
  if (!userInfo || typeof userInfo !== "object") return null;
  const unionId = (userInfo as { union_id?: unknown }).union_id;
  return typeof unionId === "string" && unionId.trim().length > 0 ? unionId.trim() : null;
}

function mockRegistrarFromEnv(): FeishuAppRegistrar | null {
  if (process.env.RUDDER_FEISHU_APP_REGISTRATION_MOCK !== "instant") return null;
  return {
    register: async (input) => {
      const appId = `cli_mock_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const launcherOrigin = input.providerRegion === "lark_global"
        ? "https://open.larksuite.com"
        : "https://open.feishu.cn";
      input.onStatusChange("Mock Feishu app authorized; Rudder quick command permissions requested");
      input.onSetupUrl({
        setupUrl: `${launcherOrigin}/page/launcher?from=sdk&name=${encodeURIComponent(input.suggestedBotName)}&source=node-sdk%2Frudder%2Fagent-integrations&tp=sdk`,
        expireInSeconds: DEFAULT_EXPIRE_SECONDS,
      });
      input.onStatusChange("Mock Feishu authorization completed");
      return {
        appId,
        appSecret: `mock-secret-${appId}`,
        installerUserId: "ou_mock_installer",
        installerUnionId: "on_mock_installer",
      };
    },
  };
}

export function createFeishuNodeSdkAppRegistrar(): FeishuAppRegistrar {
  return {
    register: async (input) => {
      const result = await lark.registerApp({
        domain: input.providerRegion === "lark_global" ? DEFAULT_LARK_DOMAIN : DEFAULT_FEISHU_DOMAIN,
        larkDomain: DEFAULT_LARK_DOMAIN,
        source: input.source,
        signal: input.signal,
        createOnly: true,
        appPreset: {
          name: input.suggestedBotName,
          desc: "Rudder agent chat integration.",
        },
        addons: {
          scopes: {
            tenant: FEISHU_AGENT_APP_TENANT_SCOPES,
          },
          events: {
            items: {
              tenant: ["im.message.receive_v1"],
            },
          },
        },
        onQRCodeReady: (info) => {
          input.onSetupUrl({ setupUrl: info.url, expireInSeconds: info.expireIn });
        },
        onStatusChange: (info) => {
          input.onStatusChange(info.status);
        },
      });
      return {
        appId: result.client_id,
        appSecret: result.client_secret,
        installerUserId: result.user_info?.open_id ?? null,
        installerUnionId: installerUnionIdFromUserInfo(result.user_info),
      };
    },
  };
}

export function feishuAppRegistrationSessionRegistry(
  registrar: FeishuAppRegistrar = mockRegistrarFromEnv() ?? createFeishuNodeSdkAppRegistrar(),
) {
  const sessions = new Map<string, FeishuAppRegistrationSessionState>();

  function summarizeSession(session: FeishuAppRegistrationSessionState): AgentIntegrationSetupSession {
    return {
      id: session.id,
      provider: "feishu",
      providerRegion: session.providerRegion,
      setupUrl: session.setupUrl,
      suggestedBotName: session.suggestedBotName,
      status: session.status,
      statusDetail: session.statusDetail,
      expiresAt: session.expiresAt,
      integration: session.integration,
    };
  }

  function scheduleCleanup(session: FeishuAppRegistrationSessionState, delayMs: number) {
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    session.cleanupTimer = setTimeout(() => {
      sessions.delete(session.id);
    }, delayMs);
  }

  function completeWithError(session: FeishuAppRegistrationSessionState, error: unknown) {
    if (session.status === "completed") return;
    const detail = normalizeError(error);
    session.status = detail.includes("expired_token") ? "expired" : "failed";
    session.statusDetail = detail;
    scheduleCleanup(session, 10 * 60 * 1000);
  }

  async function start(input: {
    orgId: string;
    agentId: string;
    providerRegion: AgentIntegrationProviderRegion;
    suggestedBotName: string;
    onAuthorizationComplete?: (
      result: FeishuAppRegistrationResult,
      session: AgentIntegrationSetupSession,
    ) => Promise<AgentIntegrationSetupSession>;
  }) {
    const id = randomUUID();
    const abortController = new AbortController();
    let setupUrlReady!: (session: AgentIntegrationSetupSession) => void;
    let setupUrlFailed!: (error: unknown) => void;
    const setupUrlPromise = new Promise<AgentIntegrationSetupSession>((resolve, reject) => {
      setupUrlReady = resolve;
      setupUrlFailed = reject;
    });

    const session: FeishuAppRegistrationSessionState = {
      id,
      orgId: input.orgId,
      agentId: input.agentId,
      providerRegion: input.providerRegion,
      suggestedBotName: input.suggestedBotName,
      setupUrl: "",
      status: "waiting_for_authorization",
      statusDetail: "Waiting for Feishu authorization",
      expiresAt: null,
      integration: null,
      result: null,
      abortController,
      cleanupTimer: null,
    };
    sessions.set(id, session);

    void registrar.register({
      providerRegion: input.providerRegion,
      suggestedBotName: input.suggestedBotName,
      source: DEFAULT_REGISTRATION_SOURCE,
      signal: abortController.signal,
      onSetupUrl: (info) => {
        session.setupUrl = info.setupUrl;
        session.expiresAt = new Date(Date.now() + info.expireInSeconds * 1000);
        scheduleCleanup(session, (info.expireInSeconds + 10 * 60) * 1000);
        setupUrlReady(summarizeSession(session));
      },
      onStatusChange: (detail) => {
        session.statusDetail = detail;
      },
    })
      .then((result) => {
        session.statusDetail = "Feishu app authorized; starting Rudder chat connection";
        if (!input.onAuthorizationComplete) {
          session.result = result;
          return;
        }
        return input.onAuthorizationComplete(result, summarizeSession(session))
          .then((completed) => {
            session.status = completed.status;
            session.statusDetail = completed.statusDetail;
            session.integration = completed.integration;
            scheduleCleanup(session, 10 * 60 * 1000);
          })
          .catch((error) => {
            completeWithError(session, error);
          });
      })
      .catch((error) => {
        if (!session.setupUrl) {
          setupUrlFailed(error);
        }
        completeWithError(session, error);
      });

    return setupUrlPromise;
  }

  function get(input: { id: string; orgId: string; agentId: string }) {
    const session = sessions.get(input.id);
    if (!session || session.orgId !== input.orgId || session.agentId !== input.agentId) return null;
    return session ? summarizeSession(session) : null;
  }

  function takeResult(input: { id: string; orgId: string; agentId: string }) {
    const session = sessions.get(input.id);
    if (!session) return null;
    if (session.orgId !== input.orgId || session.agentId !== input.agentId) return null;
    if (!session.result) return null;
    const result = session.result;
    session.result = null;
    return result;
  }

  function markCompleted(input: {
    id: string;
    orgId: string;
    agentId: string;
    integration: AgentIntegrationSummary;
  }) {
    const session = sessions.get(input.id);
    if (!session || session.orgId !== input.orgId || session.agentId !== input.agentId) return null;
    session.status = "completed";
    session.statusDetail = "Connected";
    session.integration = input.integration;
    scheduleCleanup(session, 10 * 60 * 1000);
    return summarizeSession(session);
  }

  function dispose(id: string) {
    const session = sessions.get(id);
    if (!session) return;
    session.abortController.abort();
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    sessions.delete(id);
  }

  return {
    start,
    get,
    takeResult,
    markCompleted,
    dispose,
  };
}

export const defaultFeishuAppRegistrationSessions = feishuAppRegistrationSessionRegistry();
