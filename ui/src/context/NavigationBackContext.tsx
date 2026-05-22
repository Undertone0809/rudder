import { createContext, useContext, type ReactNode } from "react";

type NavigateBackHandler = () => boolean;

const NavigationBackContext = createContext<NavigateBackHandler | null>(null);

export function NavigationBackProvider({
  children,
  navigateBack,
}: {
  children: ReactNode;
  navigateBack: NavigateBackHandler;
}) {
  return (
    <NavigationBackContext.Provider value={navigateBack}>
      {children}
    </NavigationBackContext.Provider>
  );
}

export function useNavigationBack() {
  return useContext(NavigationBackContext);
}
