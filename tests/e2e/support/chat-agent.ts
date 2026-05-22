import { expect, type APIRequestContext } from "@playwright/test";
import { E2E_CODEX_STUB } from "./e2e-env";

export async function createE2EChatAgent(
  request: APIRequestContext,
  orgId: string,
  options: {
    name?: string;
    role?: string;
    icon?: string | null;
    command?: string;
    model?: string;
    agentRuntimeConfig?: Record<string, unknown>;
  } = {},
) {
  const agentRes = await request.post(`/api/orgs/${orgId}/agents`, {
    data: {
      name: options.name ?? "Chat Agent",
      role: options.role ?? "engineer",
      icon: options.icon,
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: options.agentRuntimeConfig ?? {
        model: options.model ?? "gpt-5.4",
        command: options.command ?? E2E_CODEX_STUB,
      },
    },
  });
  expect(agentRes.ok()).toBe(true);
  return agentRes.json();
}

export function withChatAgent(path: string, agentId: string) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}agentId=${encodeURIComponent(agentId)}`;
}
