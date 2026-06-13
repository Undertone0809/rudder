import { CALENDAR_EVENT_STATUSES, type CalendarEventStatus } from "@rudderhq/shared";
import { createContext, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

export const CALENDAR_EVENT_STATUS_OPTIONS: CalendarEventStatus[] = [
  "planned",
  "in_progress",
  "actual",
  "external",
  "projected",
  "cancelled",
];

function defaultVisibleStatuses() {
  return new Set<CalendarEventStatus>(
    CALENDAR_EVENT_STATUSES.filter((status) => status !== "projected"),
  );
}

type CalendarWorkspaceContextValue = {
  cursor: Date;
  setCursor: Dispatch<SetStateAction<Date>>;
  hiddenAgentIds: Set<string>;
  setHiddenAgentIds: Dispatch<SetStateAction<Set<string>>>;
  hiddenSourceIds: Set<string>;
  setHiddenSourceIds: Dispatch<SetStateAction<Set<string>>>;
  myCalendarVisible: boolean;
  setMyCalendarVisible: Dispatch<SetStateAction<boolean>>;
  visibleStatuses: Set<CalendarEventStatus>;
  setVisibleStatuses: Dispatch<SetStateAction<Set<CalendarEventStatus>>>;
  googleCalendarModalOpen: boolean;
  setGoogleCalendarModalOpen: Dispatch<SetStateAction<boolean>>;
};

const CalendarWorkspaceContext = createContext<CalendarWorkspaceContextValue | null>(null);
const noopSetDate: Dispatch<SetStateAction<Date>> = () => undefined;
const noopSetStringSet: Dispatch<SetStateAction<Set<string>>> = () => undefined;
const noopSetBoolean: Dispatch<SetStateAction<boolean>> = () => undefined;
const noopSetStatusSet: Dispatch<SetStateAction<Set<CalendarEventStatus>>> = () => undefined;
const fallbackCalendarWorkspaceContext: CalendarWorkspaceContextValue = {
  cursor: new Date(),
  setCursor: noopSetDate,
  hiddenAgentIds: new Set(),
  setHiddenAgentIds: noopSetStringSet,
  hiddenSourceIds: new Set(),
  setHiddenSourceIds: noopSetStringSet,
  myCalendarVisible: true,
  setMyCalendarVisible: noopSetBoolean,
  visibleStatuses: defaultVisibleStatuses(),
  setVisibleStatuses: noopSetStatusSet,
  googleCalendarModalOpen: false,
  setGoogleCalendarModalOpen: noopSetBoolean,
};

export function CalendarWorkspaceProvider({ children }: { children: ReactNode }) {
  const [cursor, setCursor] = useState(() => new Date());
  const [hiddenAgentIds, setHiddenAgentIds] = useState<Set<string>>(() => new Set());
  const [hiddenSourceIds, setHiddenSourceIds] = useState<Set<string>>(() => new Set());
  const [myCalendarVisible, setMyCalendarVisible] = useState(true);
  const [visibleStatuses, setVisibleStatuses] = useState<Set<CalendarEventStatus>>(defaultVisibleStatuses);
  const [googleCalendarModalOpen, setGoogleCalendarModalOpen] = useState(false);

  const value = useMemo<CalendarWorkspaceContextValue>(() => ({
    cursor,
    setCursor,
    hiddenAgentIds,
    setHiddenAgentIds,
    hiddenSourceIds,
    setHiddenSourceIds,
    myCalendarVisible,
    setMyCalendarVisible,
    visibleStatuses,
    setVisibleStatuses,
    googleCalendarModalOpen,
    setGoogleCalendarModalOpen,
  }), [
    cursor,
    hiddenAgentIds,
    hiddenSourceIds,
    googleCalendarModalOpen,
    myCalendarVisible,
    visibleStatuses,
  ]);

  return (
    <CalendarWorkspaceContext.Provider value={value}>
      {children}
    </CalendarWorkspaceContext.Provider>
  );
}

export function useCalendarWorkspace() {
  const value = useContext(CalendarWorkspaceContext);
  return value ?? fallbackCalendarWorkspaceContext;
}
