import type { Organization } from "@rudder/shared";

const ORDER_STORAGE_KEY = "rudder.companyOrder";

function getStoredOrder(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ORDER_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as string[];
  } catch {
    // Ignore malformed local storage values and fall back to API ordering.
  }
  return [];
}

export function sortOrganizationsByStoredOrder(organizations: Organization[]): Organization[] {
  const order = getStoredOrder();
  if (order.length === 0) return organizations;

  const byId = new Map(organizations.map((organization) => [organization.id, organization]));
  const sorted: Organization[] = [];

  for (const id of order) {
    const organization = byId.get(id);
    if (organization) {
      sorted.push(organization);
      byId.delete(id);
    }
  }

  for (const organization of byId.values()) {
    sorted.push(organization);
  }

  return sorted;
}
