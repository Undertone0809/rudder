import { expect, test, type Page } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

async function createOrganization(page: Page, name: string) {
  const response = await page.request.post("/api/orgs", {
    data: { name },
  });
  expect(response.ok()).toBe(true);
  const organization = (await response.json()) as {
    id: string;
    issuePrefix: string;
  };
  const agentResponse = await page.request.post(
    `/api/orgs/${organization.id}/agents`,
    {
      data: {
        name: "Group Color Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    },
  );
  expect(agentResponse.ok()).toBe(true);
  const agent = (await agentResponse.json()) as { id: string };
  return { ...organization, agent };
}

test("default group color is a transparent-surface highlight shared with its icon", async ({
  page,
}) => {
  const organization = await createOrganization(
    page,
    `Messenger-Default-Group-Color-${Date.now()}`,
  );

  const seedGroupResponse = await page.request.post(
    `/api/orgs/${organization.id}/messenger/groups`,
    { data: { name: "Seed group", icon: "folder::slate" } },
  );
  expect(seedGroupResponse.ok()).toBe(true);

  const chatResponse = await page.request.post(
    `/api/orgs/${organization.id}/chats`,
    {
      data: {
        title: "Generated teal group",
        summary: "Create this group from the active Chat action.",
        preferredAgentId: organization.agent.id,
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: {
          body: "Create an automatically grouped Chat for color verification.",
        },
      },
    },
  );
  expect(chatResponse.ok()).toBe(true);
  const chat = (await chatResponse.json()) as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    window.localStorage.setItem(
      "rudder.messengerThreadOrganizationByOrg",
      JSON.stringify({ [orgId]: "latest" }),
    );
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`, {
    waitUntil: "commit",
  });

  const createGroupResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(
        `/api/orgs/${organization.id}/messenger/groups/merge`,
      ) && response.request().method() === "POST",
  );
  await page.getByTestId("chat-actions-trigger").click();
  await page.getByRole("menuitem", { name: "New group", exact: true }).click();
  expect((await createGroupResponse).ok()).toBe(true);

  const groupsResponse = await page.request.get(
    `/api/orgs/${organization.id}/messenger/groups`,
  );
  expect(groupsResponse.ok()).toBe(true);
  const payload = (await groupsResponse.json()) as {
    groups: Array<{ id: string; name: string }>;
  };
  const group = payload.groups.find(
    (candidate) => candidate.name === "Generated teal group",
  );
  expect(group).toBeTruthy();

  const section = page.getByTestId(
    `messenger-thread-section-custom-group-${group!.id}`,
  );
  await expect(section).toContainText("Generated teal group", {
    timeout: 15_000,
  });

  const colors = await section.evaluate((element) => {
    const icon = element.querySelector<HTMLElement>(
      '[data-testid="messenger-custom-group-icon"]',
    );
    const styles = window.getComputedStyle(element);
    return {
      groupBackground: styles.backgroundColor,
      groupBorder: styles.borderTopColor,
      iconAccent: icon?.style.getPropertyValue("--project-accent-color") ?? "",
    };
  });

  expect(colors.groupBackground).toBe("rgba(0, 0, 0, 0)");
  expect(colors.groupBorder).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.iconAccent).toBe("#08a88a");
  await page.screenshot({
    path: "/tmp/rudder-messenger-default-group-color.png",
    fullPage: true,
  });
  const cleanupResponse = await page.request.delete(
    `/api/orgs/${organization.id}`,
  );
  expect(cleanupResponse.ok()).toBe(true);
});
