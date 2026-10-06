import { type InlineKeyboardButton, esc } from "./tg";
import { STATUS_GLYPH, STATUS_LABEL, type LastResponse } from "./transcript";
import type { Question } from "./types";

/** Visible body budget; Telegram caps a message at 4096 chars including the header. */
export const BODY_BUDGET = 3300;
/** Telegram caps callback_data at 64 bytes; ids are short base36 so this never binds. */
const MAX_BUTTONS = 40;

export interface PendingQuestion {
  askId: string;
  question: Question;
  index: number;
  total: number;
  /** Multi-select: option indexes toggled on so far. */
  selected: number[];
}

export interface NotificationInput {
  repo: string;
  branch?: string;
  title?: string;
  machine: string;
  last: LastResponse;
  duration?: string;
  away: boolean;
  /** Present when the agent stopped because it needs an answer. */
  pending?: PendingQuestion;
}

export interface Rendered {
  html: string;
  /** Full text that did not fit, sent as a `.md` attachment. */
  overflow?: string;
  keyboard?: InlineKeyboardButton[][];
}

/**
 * Stop notification as HTML. Model text is escaped: arbitrary prose may contain
 * `<` or `&`, which would otherwise make Telegram reject the whole message.
 */
export function renderNotification(input: NotificationInput): Rendered {
  const glyph = input.pending ? "❓" : STATUS_GLYPH[input.last.kind];
  const label = input.pending ? "Question" : STATUS_LABEL[input.last.kind];
  const place = input.branch ? `${esc(input.repo)} · ${esc(input.branch)}` : esc(input.repo);
  const lines = [`${glyph} <b>${label}</b> · ${place}`];
  if (input.title) lines.push(`📝 ${esc(input.title)}`);
  const meta = [esc(input.machine)];
  if (input.duration) meta.push(`⏱ ${esc(input.duration)}`);
  if (input.away) meta.push("🌙 away");
  lines.push(`🖥 ${meta.join(" · ")}`);

  const body =
    input.last.text ||
    (input.last.kind === "error" ? input.last.errorMessage || "Turn failed." : "");
  let overflow: string | undefined;
  if (body) {
    const head = body.length > BODY_BUDGET ? `${body.slice(0, BODY_BUDGET)}\n…(full text attached)` : body;
    if (body.length > BODY_BUDGET) overflow = body;
    lines.push("", `<blockquote expandable>${esc(head)}</blockquote>`);
  }

  const rendered: Rendered = { html: "" };
  if (input.pending) {
    lines.push("", renderQuestion(input.pending));
    rendered.keyboard = questionKeyboard(input.pending);
  } else {
    lines.push("", "<i>Reply to this message to continue the session.</i>");
  }
  rendered.html = lines.join("\n");
  if (overflow) rendered.overflow = overflow;
  return rendered;
}

export function renderQuestion(p: PendingQuestion): string {
  const lines: string[] = [];
  const counter = p.total > 1 ? ` (${p.index + 1}/${p.total})` : "";
  const chip = p.question.header ? `[${esc(p.question.header)}] ` : "";
  lines.push(`<b>${chip}${esc(p.question.question)}</b>${counter}`);
  p.question.options.forEach((opt, i) => {
    const star = p.question.recommended === i ? " ⭐️" : "";
    const desc = opt.description ? ` — ${esc(opt.description)}` : "";
    lines.push(`${i + 1}. ${esc(opt.label)}${star}${desc}`);
  });
  lines.push(
    p.question.multi
      ? "<i>Toggle options, then ✅ Done. Or reply with your own answer.</i>"
      : "<i>Tap an option, or reply with your own answer.</i>",
  );
  return lines.join("\n");
}

/** callback_data grammar: `a:<ask>:<q>:<opt>` pick, `t:<ask>:<q>:<opt>` toggle, `d:<ask>:<q>` done. */
export function questionKeyboard(p: PendingQuestion): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  const verb = p.question.multi ? "t" : "a";
  p.question.options.slice(0, MAX_BUTTONS).forEach((opt, i) => {
    const mark = p.question.multi ? (p.selected.includes(i) ? "☑️ " : "⬜️ ") : "";
    rows.push([{ text: `${mark}${opt.label}`.slice(0, 64), callback_data: `${verb}:${p.askId}:${p.index}:${i}` }]);
  });
  if (p.question.multi) rows.push([{ text: "✅ Done", callback_data: `d:${p.askId}:${p.index}` }]);
  return rows;
}
