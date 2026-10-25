export const CHAT_STOP_CONFIRMATION_PENDING_MESSAGE =
  "Rudder could not confirm that the response stopped. It will keep trying automatically; the response may still be running.";

export const CHAT_STOP_REJECTED_MESSAGE =
  "Rudder did not accept the Stop request. The response may still be running. Refresh the chat and try again.";

export const CHAT_STOP_REQUIRES_FRESH_ACTION_MESSAGE =
  "The earlier Stop could not be tied to this response. Refresh the chat and press Stop again if it is still running.";

export const CHAT_STOP_TARGET_UNVERIFIED_MESSAGE =
  "Rudder could not verify which response to stop. Refresh the chat and try again.";

export const CHAT_STOP_OWNER_LOST_MESSAGE =
  "Run interrupted. Rudder could not confirm it stopped. This chat is paused and needs operator recovery. You can still quit Rudder.";

export const CHAT_RECOVERY_STATUS_CHECKING_MESSAGE =
  "Rudder is checking this chat's runtime recovery state. Sending is paused until the check finishes.";

export const CHAT_RECOVERY_STATUS_UNAVAILABLE_MESSAGE =
  "Rudder could not verify this chat's runtime recovery state. Sending is paused; try again after refreshing the chat.";
