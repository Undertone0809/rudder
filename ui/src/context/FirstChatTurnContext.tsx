import { useOrganization } from "@/context/OrganizationContext";
import { FirstChatTurnStore } from "@/lib/chat-first-turn-store";
import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { useInRouterContext, useLocation } from "react-router-dom";

const FirstChatTurnContext = createContext<FirstChatTurnStore | null>(null);

export function firstChatTurnOwner(orgId: string | null, locationKey: string) {
  return `${orgId ?? "__none__"}:${locationKey}`;
}

function RouteOwner({ store }: { store: FirstChatTurnStore }) {
  const location = useLocation();
  const { selectedOrganizationId } = useOrganization();
  useLayoutEffect(() => {
    store.setOwner(firstChatTurnOwner(selectedOrganizationId, location.key));
  }, [store, selectedOrganizationId, location.key]);
  return null;
}

/** Above Layout's responsive Outlet trees, so only committed navigation revokes ownership. */
export function FirstChatTurnProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new FirstChatTurnStore());
  const inRouter = useInRouterContext();
  return <FirstChatTurnContext.Provider value={store}>
    {inRouter && <RouteOwner store={store} />}
    {children}
  </FirstChatTurnContext.Provider>;
}

export function useFirstChatTurnStore() {
  const store = useContext(FirstChatTurnContext);
  if (!store) throw new Error("FirstChatTurnProvider is required");
  return store;
}
