import {
  MAX_CONSECUTIVE_RELAYS,
  RELAYED_REASON,
  createAsk,
  handleAskCallback,
  handleAskText,
  pendingOf,
} from "./ask";
import { publishCommands } from "./commands";
import { type Config, ensureDirs, errMessage, loadConfig, logErr, machineName, paths } from "./config";
import { sendStopNotification } from "./notify";
import { fetchUpdates } from "./poller";
import { type RelayHandlers, routeUpdate } from "./relay";
import {
  dropInbox,
  heartbeat,
  pruneRouting,
  readAway,
  readInbox,
  readLeader,
  readOffset,
  registerSession,
  releaseLeader,
  saveAsk,
  tryAcquireLeader,
  unregisterSession,
  writeAway,
  writeOffset,
} from "./state";
import { api, esc, logTgFailure } from "./tg";
import type { HookCtx, PiLike } from "./types";

const TICK_MS = 5_000;
const INBOX_MS = 1_500;
const CONFLICT_BACKOFF_MS = 60_000;
const ERROR_BACKOFF_MS = 5_000;

/**
 * omp Telegram bridge. Every main session on a machine registers itself, sends a
 * report on each stop, and drains its own inbox. Exactly one of them (the leader,
 * elected through a lock file) reads the bot's updates and routes them to inboxes.
 */
export default function telegram(pi: PiLike): void {
  let cfg: Config | null = null;
  let ctxRef: HookCtx | undefined;
  let sessionId = "";
  /** Interactive sessions relay; print runs only notify. */
  let relay = false;
  let leader = false;
  let polling = false;
  let pollAbort: AbortController | undefined;
  let conflictUntil = 0;
  let askRelayedThisTurn = false;
  let consecutiveRelays = 0;

  async function reply(chatId: number | string, text: string, replyTo?: number): Promise<void> {
    if (!cfg) return;
    logTgFailure(
      "sendMessage",
      await api(cfg.botToken, "sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        ...(replyTo !== undefined ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      }),
    );
  }

  const handlers: RelayHandlers = {
    async onCallback(cb, updateId) {
      if (cfg) await handleAskCallback(cfg, cb, updateId);
    },
    async onAskText(askId, text, updateId) {
      return cfg ? handleAskText(cfg, askId, text, updateId) : false;
    },
    async onUndeliverable(chatId, replyTo, reason) {
      await reply(chatId, `⚠️ ${esc(reason)}`, replyTo);
    },
    async onCommand(text, chatId) {
      const [rawCmd, arg] = text.split(/\s+/, 2);
      const cmd = rawCmd.replace(/@\S+$/, "").toLowerCase();
      if (cmd === "/away") {
        const away = arg === "on" ? true : arg === "off" ? false : !readAway();
        writeAway(away);
        await reply(chatId, away ? "🌙 Away mode <b>on</b>: questions come here." : "🏠 Away mode <b>off</b>: questions open in the terminal.");
        return true;
      }
      if (cmd === "/status" || cmd === "/start") {
        await reply(chatId, statusText());
        return true;
      }
      return false;
    },
  };

  function statusText(): string {
    const holder = readLeader();
    return [
      `🤖 <b>${esc(machineName(cfg))}</b>`,
      `🌙 away: ${readAway() ? "on" : "off"}`,
      `📡 poller: ${holder ? `pid ${holder.pid}` : "none"}`,
      `👤 allowed users: ${cfg?.allowedUserIds.join(", ") || "none (replies ignored)"}`,
    ].join("\n");
  }

  function sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  }

  /** Leader loop. Detached from handler dispatch, so it must never throw. */
  async function pollLoop(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      while (leader && cfg) {
        pollAbort = new AbortController();
        const outcome = await fetchUpdates(cfg, readOffset(), pollAbort.signal);
        if (!leader) break;
        if (outcome.conflict) {
          logErr(`getUpdates conflict: another process reads this bot (${outcome.error}); backing off`);
          leader = false;
          releaseLeader(sessionId);
          conflictUntil = Date.now() + CONFLICT_BACKOFF_MS;
          break;
        }
        if (outcome.error) {
          logErr(`getUpdates: ${outcome.error}`);
          await sleep(ERROR_BACKOFF_MS);
          continue;
        }
        for (const update of outcome.updates) {
          try {
            const dropped = await routeUpdate(cfg, update, handlers);
            if (dropped) logErr(`update ${update.update_id} dropped: ${dropped}`);
          } catch (e) {
            // Offset not advanced: Telegram redelivers this update on the next poll.
            logErr(`update ${update.update_id} failed: ${errMessage(e)}`);
            await sleep(ERROR_BACKOFF_MS);
            break;
          }
          writeOffset(update.update_id + 1);
        }
      }
    } catch (e) {
      logErr(`poll loop: ${errMessage(e)}`);
      leader = false;
      releaseLeader(sessionId);
    } finally {
      polling = false;
    }
  }

  function tick(): void {
    if (!relay || !cfg) return;
    if (leader) {
      if (!heartbeat(sessionId)) {
        leader = false;
        pollAbort?.abort();
      }
      return;
    }
    if (Date.now() < conflictUntil) return;
    if (tryAcquireLeader(sessionId)) {
      leader = true;
      pruneRouting();
      // Only the leader publishes: one call per machine, and only when the
      // list actually changed. A failure here must not cost leadership.
      void publishCommands(cfg.botToken).catch((e: unknown) =>
        logErr(`setMyCommands: ${errMessage(e)}`),
      );
      void pollLoop();
    }
  }

  function drainInbox(): void {
    if (!relay || !sessionId) return;
    const { items, commit } = readInbox(sessionId);
    if (!items.length) return;
    // One message per drain: separate prompts started back-to-back would race the idle check.
    const text = items.map((i) => i.text).join("\n\n");
    const busy = ctxRef?.isIdle?.() === false;
    pi.sendUserMessage(`[via Telegram] ${text}`, {
      attribution: "user",
      ...(busy ? { deliverAs: "followUp" as const } : {}),
    });
    commit();
    consecutiveRelays = 0;
  }

  function start(ctx: HookCtx): void {
    if (ctx.agent?.kind === "sub") return;
    cfg = loadConfig();
    if (!cfg) return;
    ctxRef = ctx;
    sessionId = ctx.sessionManager?.getSessionId?.() ?? `pid${process.pid}`;
    const mode = ctx.mode ?? "tui";
    relay =
      (mode === "tui" || mode === "rpc") &&
      cfg.allowedUserIds.length > 0 &&
      typeof ctx.setInterval === "function";
    if (!relay) return;
    ensureDirs();
    registerSession({ sessionId, pid: process.pid, cwd: ctx.cwd, title: pi.getSessionName?.(), ts: Date.now() });
    ctx.setInterval?.(tick, TICK_MS);
    ctx.setInterval?.(drainInbox, INBOX_MS);
    tick();
  }

  function stop(): void {
    relay = false;
    leader = false;
    pollAbort?.abort();
    if (!sessionId) return;
    releaseLeader(sessionId);
    unregisterSession(sessionId);
    dropInbox(sessionId);
  }

  pi.on("session_start", (_event, ctx) => start(ctx));

  pi.on("session_switch", (_event, ctx) => {
    if (ctx.agent?.kind === "sub") return;
    const next = ctx.sessionManager?.getSessionId?.();
    if (!next || next === sessionId) return;
    stop();
    start(ctx);
  });

  pi.on("session_shutdown", () => stop());

  pi.on<{ toolName?: string; input?: unknown }>("tool_call", async (event, ctx) => {
    if (event.toolName !== "ask" || ctx.agent?.kind === "sub") return undefined;
    if (!relay || !cfg || !readAway() || consecutiveRelays >= MAX_CONSECUTIVE_RELAYS) return undefined;
    const rec = createAsk(sessionId, event.input);
    if (!rec) return undefined;
    const messageId = await sendStopNotification({
      pi,
      ctx,
      cfg,
      sessionId,
      away: true,
      pending: pendingOf(rec),
      last: { text: "", kind: "done" },
    });
    // Telegram unreachable: let the terminal dialog run instead of losing the question.
    if (messageId === undefined) return undefined;
    saveAsk({ ...rec, messageId });
    consecutiveRelays++;
    askRelayedThisTurn = true;
    return { block: true, reason: RELAYED_REASON };
  });

  pi.on("session_stop", async (_event, ctx) => {
    if (ctx.agent?.kind === "sub") return undefined;
    // The relayed question already went out; a second "finished" ping would be noise.
    if (askRelayedThisTurn) {
      askRelayedThisTurn = false;
      return undefined;
    }
    const current = cfg ?? loadConfig();
    if (!current) return undefined;
    try {
      await sendStopNotification({
        pi,
        ctx,
        cfg: current,
        sessionId: sessionId || (ctx.sessionManager?.getSessionId?.() ?? `pid${process.pid}`),
        away: readAway(),
      });
    } catch (e) {
      logErr(`session_stop: ${errMessage(e)}`);
    }
    return undefined;
  });

  pi.registerCommand("telegram", {
    description: "Telegram bridge: status | away [on|off] | test",
    handler: async (args, ctx) => {
      const [sub, arg] = args.trim().split(/\s+/);
      const say = (text: string) => ctx.ui?.notify?.(text, "info");
      const current = cfg ?? loadConfig();
      if (!current) {
        say(`Not configured. Run: bun <plugin>/scripts/setup.ts  (config: ${paths().config})`);
        return;
      }
      if (sub === "away") {
        const away = arg === "on" ? true : arg === "off" ? false : !readAway();
        writeAway(away);
        say(`Away mode ${away ? "on: ask questions go to Telegram" : "off"}`);
        return;
      }
      if (sub === "test") {
        const res = await api(current.botToken, "sendMessage", {
          chat_id: current.chatId,
          text: `🧪 Test from ${machineName(current)}`,
        });
        say(res.ok ? "Test message sent" : `Send failed: ${res.description}`);
        return;
      }
      say(statusText().replace(/<[^>]+>/g, "") + `\nrelay: ${relay ? "on" : "off"} · leader here: ${leader}`);
    },
  });
}
