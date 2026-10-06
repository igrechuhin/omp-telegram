import { apiBase, logErr } from "./config";
import { isRecord } from "./guard";

export interface TgResult {
  ok: boolean;
  status: number;
  result?: unknown;
  description?: string;
}

export interface TgUser {
  id: number;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  chat_id: number;
  text?: string;
  from?: TgUser;
  reply_to_message_id?: number;
}

export interface TgCallbackQuery {
  id: string;
  data?: string;
  from?: TgUser;
  message?: TgMessage;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

/** Telegram's HTML parse mode needs exactly these three escaped. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Strips the bot token out of anything destined for a log line. */
export function redact(text: string, token: string): string {
  return token ? text.split(token).join("<token>") : text;
}

function asUser(value: unknown): TgUser | undefined {
  if (!isRecord(value) || typeof value.id !== "number") return undefined;
  return { id: value.id, username: typeof value.username === "string" ? value.username : undefined };
}

export function asMessage(value: unknown): TgMessage | undefined {
  if (!isRecord(value) || typeof value.message_id !== "number") return undefined;
  if (!isRecord(value.chat) || typeof value.chat.id !== "number") return undefined;
  const reply = value.reply_to_message;
  return {
    message_id: value.message_id,
    chat_id: value.chat.id,
    text: typeof value.text === "string" ? value.text : undefined,
    from: asUser(value.from),
    reply_to_message_id:
      isRecord(reply) && typeof reply.message_id === "number" ? reply.message_id : undefined,
  };
}

export function asUpdates(result: unknown): TgUpdate[] {
  if (!Array.isArray(result)) return [];
  const updates: TgUpdate[] = [];
  for (const raw of result) {
    if (!isRecord(raw) || typeof raw.update_id !== "number") continue;
    const cb = raw.callback_query;
    updates.push({
      update_id: raw.update_id,
      message: asMessage(raw.message),
      callback_query:
        isRecord(cb) && typeof cb.id === "string"
          ? {
              id: cb.id,
              data: typeof cb.data === "string" ? cb.data : undefined,
              from: asUser(cb.from),
              message: asMessage(cb.message),
            }
          : undefined,
    });
  }
  return updates;
}

export function asMessageId(result: unknown): number | undefined {
  return isRecord(result) && typeof result.message_id === "number" ? result.message_id : undefined;
}

async function parse(res: Response, token: string): Promise<TgResult> {
  const body: unknown = await res.json().catch(() => undefined);
  if (res.ok && isRecord(body) && body.ok === true) {
    return { ok: true, status: res.status, result: body.result };
  }
  const description =
    isRecord(body) && typeof body.description === "string" ? body.description : `HTTP ${res.status}`;
  return { ok: false, status: res.status, description: redact(description, token) };
}

function failure(e: unknown, token: string, timeoutMs: number): TgResult {
  const timedOut = e instanceof Error && e.name === "TimeoutError";
  const text = timedOut ? `timeout after ${timeoutMs}ms` : e instanceof Error ? e.message : String(e);
  return { ok: false, status: 0, description: redact(text, token) };
}

export async function api(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<TgResult> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(`${apiBase()}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    return await parse(res, token);
  } catch (e) {
    return failure(e, token, timeoutMs);
  }
}

/** Multipart upload, used for full response text beyond the message cap. */
export async function apiForm(
  token: string,
  method: string,
  form: FormData,
  timeoutMs = 20_000,
): Promise<TgResult> {
  try {
    const res = await fetch(`${apiBase()}/bot${token}/${method}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await parse(res, token);
  } catch (e) {
    return failure(e, token, timeoutMs);
  }
}

export function logTgFailure(scope: string, res: TgResult): void {
  if (!res.ok) logErr(`${scope}: ${res.description}`);
}
