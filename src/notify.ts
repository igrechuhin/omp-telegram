import { type Config, machineName } from "./config";
import { type PendingQuestion, renderNotification } from "./format";
import { describeProject } from "./git";
import { recordRouting } from "./state";
import { type LastResponse, formatDuration, lastAssistant, turnStartedAt } from "./transcript";
import { api, apiForm, asMessageId, logTgFailure } from "./tg";
import type { HookCtx, PiLike } from "./types";

export interface NotifyArgs {
  pi: PiLike;
  ctx: HookCtx;
  cfg: Config;
  sessionId: string;
  away: boolean;
  /** Set when the agent stopped on an `ask` that was relayed to Telegram. */
  pending?: PendingQuestion;
  /** Overrides the transcript's last assistant message (ask relay sends no body). */
  last?: LastResponse;
}

/**
 * Sends the end-of-turn report, then records which session owns the resulting
 * message so a reply can be routed back to it. Returns the Telegram message id.
 *
 * Awaited by `session_stop`, so every network call here is timeout-bounded.
 */
export async function sendStopNotification(args: NotifyArgs): Promise<number | undefined> {
  const { pi, ctx, cfg, sessionId, away, pending } = args;
  const mode = ctx.mode ?? "tui";
  if (mode !== "tui" && mode !== "rpc" && cfg.notifyNonInteractive === false) return undefined;

  const entries = ctx.sessionManager?.getBranch?.() ?? [];
  const project = await describeProject(pi, ctx.cwd);
  const started = turnStartedAt(entries);

  const rendered = renderNotification({
    repo: project.repo,
    branch: project.branch,
    title: pi.getSessionName?.(),
    machine: machineName(cfg),
    last: args.last ?? lastAssistant(entries),
    duration: started ? formatDuration(Date.now() - started) : undefined,
    away,
    pending,
  });

  const res = await api(
    cfg.botToken,
    "sendMessage",
    {
      chat_id: cfg.chatId,
      text: rendered.html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(rendered.keyboard ? { reply_markup: { inline_keyboard: rendered.keyboard } } : {}),
    },
    8_000,
  );
  if (!res.ok) {
    logTgFailure("sendMessage", res);
    return undefined;
  }
  const messageId = asMessageId(res.result);
  if (messageId === undefined) return undefined;
  recordRouting({ messageId, sessionId, askId: pending?.askId, ts: Date.now() });

  if (rendered.overflow) {
    const form = new FormData();
    form.set("chat_id", cfg.chatId);
    form.set("reply_parameters", JSON.stringify({ message_id: messageId }));
    form.set("caption", `Full response · ${project.repo}`);
    form.set(
      "document",
      new Blob([rendered.overflow], { type: "text/markdown" }),
      `${project.repo}-response.md`,
    );
    logTgFailure("sendDocument", await apiForm(cfg.botToken, "sendDocument", form, 20_000));
  }
  return messageId;
}
