## Chat Pin + Unread Attention Plan

Date: 2026-04-09
Status: In progress

### Goal

Add a durable per-user chat attention model so important chats can be pinned, unread assistant replies can surface reliably, the chat list can show unread state, and inbox can aggregate chat attention without turning chat into a generic IM notification stream.

### Product decisions

1. `pin` is per-user, not organization-shared.
2. `unread` is per-user and durable across refresh/restart.
3. `unread` is driven by the latest non-user chat messages relative to the board user's `lastReadAt`.
4. `Inbox` only includes chat items that need board attention:
   - unread assistant/system replies
   - pending or revision-requested proposal review blocks
5. Ordinary user-authored chat messages do not create inbox notifications.

### Backend changes

1. Add `chat_conversation_user_states`
   - `org_id`
   - `conversation_id`
   - `user_id`
   - `last_read_at`
   - `pinned_at`
2. Extend chat conversation responses with:
   - `isPinned`
   - `isUnread`
   - `unreadCount`
   - `needsAttention`
   - `lastReadAt`
3. Add chat user-state endpoints:
   - mark conversation read
   - set pinned/unpinned
4. Include chat attention counts in sidebar badge responses.
5. Emit live activity for assistant/system chat messages so UI can invalidate and notify.

### UI changes

1. Chat list
   - pinned section before recent chats
   - unread dot on row
   - pin/unpin action in row menu
2. Chat page
   - mark active conversation read when visible and messages are loaded
3. Inbox
   - include chat attention items in unread/recent/all views
   - preserve existing approvals / runs / touched-issues behavior
4. Live updates
   - invalidate chat queries on chat activity
   - show toast for new assistant/system chat replies when the conversation is not currently open

### Validation

1. Typecheck
2. Targeted tests for chat service / inbox helpers if needed
3. Browser verification of:
   - pin/unpin
   - unread dot clears on open
   - inbox shows chat attention row
