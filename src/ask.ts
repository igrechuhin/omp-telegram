import type { Config } from "./config";
import { type PendingQuestion, questionKeyboard, renderQuestion } from "./format";
import { type AskRecord, appendInbox, loadAsk, recordRouting, saveAsk } from "./state";
import { type TgCallbackQuery, api, asMessageId, logTgFailure } from "./tg";
import { asQuestions } from "./types";

/**
 * After this many relayed asks in a row without a delivered answer, the next `ask`
 * runs in the terminal: a model that keeps re-asking must not wedge the session.
 */
export const MAX_CONSECUTIVE_RELAYS = 3;

/** Returned to the model as the blocked tool call's reason. */
export const RELAYED_REASON =
  "The user is away from the terminal, so this question was sent to them on Telegram. " +
  "End your turn now without further tool calls and without re-asking. " +
  "Their answer will arrive as the next user message.";

export function createAsk(sessionId: string, input: unknown): AskRecord | undefined {
  const questions = asQuestions(input);
  if (!questions.length) return undefined;
  const rec: AskRecord = {
    askId: Math.random().toString(36).slice(2, 10),
    sessionId,
    questions,
    index: 0,
    answers: [],
    selected: [],
    done: false,
    ts: Date.now(),
  };
  saveAsk(rec);
  return rec;
}

export function pendingOf(rec: AskRecord): PendingQuestion {
  return {
    askId: rec.askId,
    question: rec.questions[rec.index],
    index: rec.index,
    total: rec.questions.length,
    selected: rec.selected,
  };
}

export function formatAnswers(rec: AskRecord): string {
  const lines = rec.questions.map((q, i) => `- ${q.question} → ${rec.answers[i] ?? "(no answer)"}`);
  return `Answers to your question${rec.questions.length > 1 ? "s" : ""}:\n${lines.join("\n")}`;
}

/**
 * Records one answer and moves on: the next question goes out as a new message, and
 * after the last one the combined answer lands in the session's inbox.
 *
 * Persists only after Telegram accepted the follow-up message, so a failure throws
 * with the record unchanged and the redelivered update replays cleanly.
 */
async function answerCurrent(
  cfg: Config,
  rec: AskRecord,
  answer: string,
  updateId: number,
  answeredMessageId: number | undefined,
): Promise<void> {
  if (answeredMessageId !== undefined) {
    logTgFailure(
      "editMessageReplyMarkup",
      await api(cfg.botToken, "editMessageReplyMarkup", {
        chat_id: cfg.chatId,
        message_id: answeredMessageId,
        reply_markup: { inline_keyboard: [] },
      }),
    );
  }
  const next: AskRecord = {
    ...rec,
    answers: [...rec.answers, answer],
    index: rec.index + 1,
    selected: [],
  };

  if (next.index < next.questions.length) {
    const pending = pendingOf(next);
    const res = await api(cfg.botToken, "sendMessage", {
      chat_id: cfg.chatId,
      text: `❓ ${renderQuestion(pending)}`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: questionKeyboard(pending) },
      ...(answeredMessageId !== undefined ? { reply_parameters: { message_id: answeredMessageId } } : {}),
    });
    const messageId = asMessageId(res.result);
    if (!res.ok || messageId === undefined) throw new Error(`next question: ${res.description}`);
    recordRouting({ messageId, sessionId: rec.sessionId, askId: rec.askId, ts: Date.now() });
    saveAsk({ ...next, messageId });
    return;
  }

  const done: AskRecord = { ...next, done: true };
  appendInbox(rec.sessionId, {
    updateId,
    text: formatAnswers(done),
    fromId: 0,
    askId: rec.askId,
    ts: Date.now(),
  });
  saveAsk(done);
  logTgFailure(
    "sendMessage",
    await api(cfg.botToken, "sendMessage", {
      chat_id: cfg.chatId,
      text: "✅ Sent to the session.",
      ...(answeredMessageId !== undefined ? { reply_parameters: { message_id: answeredMessageId } } : {}),
    }),
  );
}

/** callback_data: `a:<ask>:<q>:<opt>` pick, `t:<ask>:<q>:<opt>` toggle, `d:<ask>:<q>` done. */
export async function handleAskCallback(
  cfg: Config,
  cb: TgCallbackQuery,
  updateId: number,
): Promise<void> {
  const [verb, askId, qRaw, optRaw] = (cb.data ?? "").split(":");
  const ack = async (text?: string) =>
    logTgFailure(
      "answerCallbackQuery",
      await api(cfg.botToken, "answerCallbackQuery", { callback_query_id: cb.id, text }),
    );
  const rec = askId ? loadAsk(askId) : undefined;
  if (!rec || rec.done || Number(qRaw) !== rec.index) {
    await ack("Already answered.");
    return;
  }
  const question = rec.questions[rec.index];
  const messageId = cb.message?.message_id;

  if (verb === "a") {
    const option = question.options[Number(optRaw)];
    if (!option) return ack();
    await ack(`✓ ${option.label}`);
    await answerCurrent(cfg, rec, option.label, updateId, messageId);
    return;
  }
  if (verb === "t") {
    const idx = Number(optRaw);
    if (!question.options[idx]) return ack();
    const selected = rec.selected.includes(idx)
      ? rec.selected.filter((n) => n !== idx)
      : [...rec.selected, idx].sort((a, b) => a - b);
    const updated: AskRecord = { ...rec, selected };
    saveAsk(updated);
    await ack();
    if (messageId !== undefined) {
      logTgFailure(
        "editMessageReplyMarkup",
        await api(cfg.botToken, "editMessageReplyMarkup", {
          chat_id: cfg.chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: questionKeyboard(pendingOf(updated)) },
        }),
      );
    }
    return;
  }
  if (verb === "d") {
    if (!rec.selected.length) return ack("Select at least one option, or reply with text.");
    await ack("✓ Sent");
    const labels = rec.selected.map((i) => question.options[i]?.label).filter(Boolean);
    await answerCurrent(cfg, rec, labels.join(", "), updateId, messageId);
    return;
  }
  await ack();
}

/** A text reply to a question message answers it as "Other". False if the ask is closed. */
export async function handleAskText(
  cfg: Config,
  askId: string,
  text: string,
  updateId: number,
): Promise<boolean> {
  const rec = loadAsk(askId);
  if (!rec || rec.done) return false;
  await answerCurrent(cfg, rec, text, updateId, rec.messageId);
  return true;
}
