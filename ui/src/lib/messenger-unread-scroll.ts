export const MESSENGER_SCROLL_TO_UNREAD_EVENT = "rudder:messenger-scroll-to-unread";

let messengerUnreadScrollRequestId = 0;

export function getMessengerUnreadScrollRequestId() {
  return messengerUnreadScrollRequestId;
}

export function requestMessengerUnreadScroll() {
  if (typeof document === "undefined") return;

  messengerUnreadScrollRequestId += 1;

  const dispatch = () => {
    document.dispatchEvent(new CustomEvent(MESSENGER_SCROLL_TO_UNREAD_EVENT, {
      detail: { requestId: messengerUnreadScrollRequestId },
    }));
  };

  dispatch();

  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(dispatch);
    return;
  }

  setTimeout(dispatch, 0);
}
