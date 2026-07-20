export const ISSUE_EXECUTION_RELEASED_EVENT_TYPE = "issue.execution_released";

export function isOperatorHiddenEventType(eventType: string): boolean {
  return eventType === ISSUE_EXECUTION_RELEASED_EVENT_TYPE;
}
