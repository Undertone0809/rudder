import { useOrganization } from "@/context/OrganizationContext";
import { FirstChatTurnStore } from "@/lib/chat-first-turn-store";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useInRouterContext, useLocation, useNavigationType } from "react-router-dom";

const FirstChatTurnContext = createContext<FirstChatTurnStore | null>(null);
const FIRST_CHAT_TURN_OWNER_KEY = "__rudderFirstChatTurnOwnerKey";

type FirstChatTurnLocation = { key: string; pathname: string; state: unknown };
type FirstChatTurnRoute = { key: string; ownerKey: string; pathname: string; orgId: string | null };

export function firstChatTurnOwner(orgId: string | null, locationKey: string) {
  return `${orgId ?? "__none__"}:${locationKey}`;
}

function firstChatTurnRouteState(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function preserveFirstChatTurnOwnerState(location: FirstChatTurnLocation) {
  const state = firstChatTurnRouteState(location.state) ?? {};
  const existingOwnerKey = state[FIRST_CHAT_TURN_OWNER_KEY];
  return {
    ...state,
    [FIRST_CHAT_TURN_OWNER_KEY]: typeof existingOwnerKey === "string" ? existingOwnerKey : location.key,
  };
}

export function shouldPreserveFirstChatTurnOwner(
  previous: FirstChatTurnRoute | null,
  location: FirstChatTurnLocation & { orgId: string | null },
  navigationType: "POP" | "PUSH" | "REPLACE",
) {
  const ownerKey = firstChatTurnRouteState(location.state)?.[FIRST_CHAT_TURN_OWNER_KEY];
  return navigationType === "REPLACE"
    && previous !== null
    && previous.key !== location.key
    && previous.ownerKey === ownerKey
    && previous.orgId === location.orgId
    && toOrganizationRelativePath(previous.pathname) === toOrganizationRelativePath(location.pathname);
}

function RouteOwner({ store }: { store: FirstChatTurnStore }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const { selectedOrganizationId } = useOrganization();
  const previousRoute = useRef<FirstChatTurnRoute | null>(null);
  useLayoutEffect(() => {
    const currentRoute = {
      key: location.key,
      pathname: location.pathname,
      orgId: selectedOrganizationId,
    };
    const previous = previousRoute.current;
    const preserveOwner = shouldPreserveFirstChatTurnOwner(
      previous,
      { ...location, orgId: selectedOrganizationId },
      navigationType,
    );
    if (!preserveOwner) store.setOwner(firstChatTurnOwner(selectedOrganizationId, location.key));
    previousRoute.current = {
      ...currentRoute,
      ownerKey: preserveOwner && previous ? previous.ownerKey : location.key,
    };
  }, [store, selectedOrganizationId, location.key, location.pathname, location.state, navigationType]);
  return null;
}

/** Only explicitly preserved replacements within the same organization route keep ownership. */
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
