import type { Config } from "./config";
import { type TgUpdate, api, asUpdates } from "./tg";

/**
 * Telegram holds the request open this long when there is nothing to report, so the
 * leader's heartbeat must run independently of the poll (see LEADER_STALE_MS).
 */
export const LONG_POLL_SECONDS = 25;

export interface PollOutcome {
  updates: TgUpdate[];
  /** Another process is already reading this bot's updates (HTTP 409). */
  conflict: boolean;
  error?: string;
}

/**
 * One `getUpdates` call. The caller advances the offset only after every returned
 * update is persisted, so a crash mid-batch makes Telegram redeliver rather than
 * drop a reply.
 */
export async function fetchUpdates(
  cfg: Config,
  offset: number | undefined,
  signal?: AbortSignal,
): Promise<PollOutcome> {
  const res = await api(
    cfg.botToken,
    "getUpdates",
    { offset, timeout: LONG_POLL_SECONDS, allowed_updates: ["message", "callback_query"] },
    (LONG_POLL_SECONDS + 10) * 1000,
    signal,
  );
  if (res.ok) return { updates: asUpdates(res.result), conflict: false };
  const description = res.description ?? "";
  const conflict = res.status === 409 || /terminated by other getUpdates/i.test(description);
  return { updates: [], conflict, error: description };
}
