import type { Config } from "./config";
import { type RoutingRecord, appendInbox, latestLiveRouting, liveSession, resolveRouting } from "./state";
import type { TgCallbackQuery, TgUpdate } from "./tg";

export interface RelayHandlers {
  onCallback(cb: TgCallbackQuery, updateId: number): Promise<void>;
  onAskText(askId: string, text: string, updateId: number): Promise<boolean>;
  /** Tells the sender why a message went nowhere (session ended, unknown message). */
  onUndeliverable(chatId: number, replyTo: number, reason: string): Promise<void>;
  onCommand(text: string, chatId: number): Promise<boolean>;
}

/**
 * Telegram text becomes a prompt for an agent that can run shell commands, so the
 * sender must be on the configured allowlist. An empty list denies everyone.
 */
export function isAuthorized(cfg: Config, userId: number | undefined): boolean {
  return userId !== undefined && cfg.allowedUserIds.includes(userId);
}

/**
 * Routes one update to the session that owns it:
 * - a reply follows the message it answers (works in the shared group);
 * - bare text goes to the newest live session, but only in a private chat — in a
 *   group it could reach several machines' bots and be injected everywhere;
 * - a button tap carries its ask id in `callback_data`.
 *
 * Returns a reason when the update was dropped (for the leader's log); `undefined`
 * means it was consumed. Throws only when persisting failed, so the caller keeps
 * the Telegram offset and the update is redelivered.
 */
export async function routeUpdate(
  cfg: Config,
  update: TgUpdate,
  handlers: RelayHandlers,
): Promise<string | undefined> {
  const cb = update.callback_query;
  if (cb) {
    if (!isAuthorized(cfg, cb.from?.id)) return "callback from unauthorized user";
    await handlers.onCallback(cb, update.update_id);
    return undefined;
  }
  const msg = update.message;
  const text = msg?.text?.trim();
  if (!msg || !text) return undefined;
  if (!isAuthorized(cfg, msg.from?.id)) return "message from unauthorized user";
  if (text.startsWith("/") && (await handlers.onCommand(text, msg.chat_id))) return undefined;

  let routing: RoutingRecord | undefined;
  if (msg.reply_to_message_id !== undefined) {
    routing = resolveRouting(msg.reply_to_message_id);
    if (!routing) {
      await handlers.onUndeliverable(
        msg.chat_id,
        msg.message_id,
        "Unknown or expired message: reply to a recent notification from this bot.",
      );
      return "reply to unknown message";
    }
  } else {
    // Private chats have positive ids; groups and channels are negative.
    if (msg.chat_id < 0) return "bare text in group (reply to a notification instead)";
    routing = latestLiveRouting();
    if (!routing) {
      await handlers.onUndeliverable(msg.chat_id, msg.message_id, "No running session on this machine.");
      return "no routing target";
    }
  }
  if (!liveSession(routing.sessionId)) {
    await handlers.onUndeliverable(msg.chat_id, msg.message_id, "That session has ended.");
    return "session ended";
  }
  if (routing.askId && (await handlers.onAskText(routing.askId, text, update.update_id))) {
    return undefined;
  }
  appendInbox(routing.sessionId, {
    updateId: update.update_id,
    text,
    fromId: msg.from?.id ?? 0,
    ts: Date.now(),
  });
  return undefined;
}
