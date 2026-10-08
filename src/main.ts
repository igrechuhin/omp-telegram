import {
  MAX_CONSECUTIVE_RELAYS,
  RELAYED_REASON,
  handleAskCallback,
  handleAskText,
  relayAsk,
} from "./ask";
import { publishCommands } from "./commands";
import {
  type Config,
  ensureDirs,
  errMessage,
  loadConfig,
  logErr,
  machineName,
  paths,
  saveConfig,
} from "./config";
import { askWithEscalation } from "./escalate";
import { sendStopNotification } from "./notify";
import { fetchUpdates } from "./poller";
import { type RelayHandlers, isExitCommand, routeUpdate } from "./relay";
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
 * Mirrors the native `ask` description: the shadowing tool must present the same
 * contract to the model, since only the answer's delivery channel differs.
 */
const ASK_DESCRIPTION =
  "Prompts the interactive user for one or more option-picker or free-form answers. " +
  "Ask only for decisions the user must make; act on repo context when it can answer. " +
  "Give each question a stable `id`, 2-5 concise options, and set `multi` when several " +
  "may be selected. The user may instead answer freely, so never assume an exact label.";

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
  /** setInterval is not reversible here, so timers are armed at most once. */
  let timersArmed = false;
  /** The shadowing `ask` tool is registered at most once, and only when configured. */
  let askToolRegistered = false;

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
      `⏱ escalate: ${cfg?.askEscalateMs ? `${Math.round(cfg.askEscalateMs / 1000)}s` : "off"}`,
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

  /**
   * Registers this session for relay once a usable config exists. Returns false
   * while the plugin is unconfigured, so the caller retries on a later tick.
   */
  function activate(): boolean {
    if (relay) return true;
    if (!cfg || cfg.allowedUserIds.length === 0 || !ctxRef) return false;
    relay = true;
    ensureDirs();
    registerSession({
      sessionId,
      pid: process.pid,
      cwd: ctxRef.cwd,
      title: pi.getSessionName?.(),
      ts: Date.now(),
    });
    return true;
  }

  function tick(): void {
    if (!relay) {
      // Setup may have run after this session started. Re-reading here is what
      // keeps a long-lived session from staying inert until it is restarted.
      cfg = loadConfig();
      if (!activate()) return;
    }
    if (!cfg) return;
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

  /** Set once a remote /exit is accepted, so later drains cannot act on it again. */
  let exiting = false;

  function drainInbox(): Promise<void> | undefined {
    if (!relay || !sessionId || exiting) return undefined;
    const { items, commit } = readInbox(sessionId);
    if (!items.length) return undefined;
    if (items.some((i) => isExitCommand(i.text))) {
      // Commit before shutting down: the session ends, so anything else queued
      // with the /exit is dropped rather than injected into a dying turn.
      commit();
      exiting = true;
      return endFromTelegram().catch((e: unknown) => logErr(`remote exit: ${errMessage(e)}`));
    }
    // One message per drain: separate prompts started back-to-back would race the idle check.
    const text = items.map((i) => i.text).join("\n\n");
    const busy = ctxRef?.isIdle?.() === false;
    pi.sendUserMessage(`[via Telegram] ${text}`, {
      attribution: "user",
      ...(busy ? { deliverAs: "followUp" as const } : {}),
    });
    commit();
    consecutiveRelays = 0;
    return undefined;
  }

  async function endFromTelegram(): Promise<void> {
    const ctx = ctxRef;
    if (!cfg) return;
    if (!ctx?.shutdown) {
      exiting = false;
      await reply(cfg.chatId, "⚠️ This omp build cannot end a session remotely.");
      return;
    }
    const title = pi.getSessionName?.();
    await reply(
      cfg.chatId,
      `⏹ Ending session${title ? ` <b>${esc(title)}</b>` : ""} on ${esc(machineName(cfg))}.`,
    );
    try {
      await ctx.shutdown();
    } catch (e) {
      exiting = false;
      logErr(`remote exit: ${errMessage(e)}`);
    }
  }

  /**
   * Idempotent: leadership requires a heartbeat, so any path that can activate
   * the relay must guarantee the timers exist.
   */
  function armTimers(ctx: HookCtx): void {
    if (timersArmed || typeof ctx.setInterval !== "function") return;
    timersArmed = true;
    ctx.setInterval(tick, TICK_MS);
    ctx.setInterval(drainInbox, INBOX_MS);
  }

  function start(ctx: HookCtx): void {
    if (ctx.agent?.kind === "sub") return;
    ctxRef = ctx;
    sessionId = ctx.sessionManager?.getSessionId?.() ?? `pid${process.pid}`;
    cfg = loadConfig();
    const mode = ctx.mode ?? "tui";
    // Print/json runs only notify on stop; they never relay, so no timers.
    if (!((mode === "tui" || mode === "rpc") && typeof ctx.setInterval === "function")) return;
    activate();
    if (cfg?.askEscalateMs) registerAskTool();
    armTimers(ctx);
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


  /**
   * Relays a question the terminal dialog left unanswered. Returns false when it could
   * not be delivered, which hands the question back to the terminal.
   */
  async function escalateAsk(input: Record<string, unknown>): Promise<boolean> {
    const current = cfg;
    const ctx = ctxRef;
    if (!relay || !current || !ctx) return false;
    if (!(await relayAsk({ pi, ctx, cfg: current, sessionId, away: false, input }))) return false;
    consecutiveRelays++;
    // The question already went out; session_stop must not ping a second time.
    askRelayedThisTurn = true;
    return true;
  }

  /**
   * Shadows the built-in `ask` so the call can be raced against the escalation timer.
   * A `tool_call` hook cannot do this: it may only block a call, and cannot cancel a
   * dialog the host already opened. Registered only once escalation is configured, so
   * the native tool is left alone by default.
   */
  function registerAskTool(): void {
    const z = pi.zod;
    if (askToolRegistered || typeof pi.registerTool !== "function" || !z) return;
    askToolRegistered = true;
    try {
      pi.registerTool({
        name: "ask",
        label: "Ask",
        description: ASK_DESCRIPTION,
        strict: true,
        // Reads an answer; it must never raise an approval prompt of its own.
        approval: "read",
        // Native ask is exclusive: the dialog owns a shared terminal surface.
        concurrency: "exclusive",
        parameters: z.object({
          questions: z.array(
            z.object({
              id: z.string(),
              question: z.string(),
              options: z.array(
                z.object({
                  label: z.string(),
                  description: z.string().optional(),
                  // Accepted for native parity. Telegram renders labels and
                  // descriptions only, so a relayed question drops it.
                  preview: z.string().optional(),
                }),
              ),
              header: z.string().optional(),
              multi: z.boolean().optional(),
              recommended: z.number().optional(),
            }),
          ),
        }),
        execute: (_id, params, signal, onUpdate, toolCtx) =>
          askWithEscalation(params, signal, onUpdate, toolCtx, {
            // away mode already relayed before execute, and a spent relay budget
            // means the question belongs to the terminal.
            escalateMs: () =>
              relay && cfg?.askEscalateMs && !readAway() && consecutiveRelays < MAX_CONSECUTIVE_RELAYS
                ? cfg.askEscalateMs
                : 0,
            escalate: escalateAsk,
          }),
      });
    } catch (e) {
      // An older host may reject an unknown field; native ask then stays in charge.
      askToolRegistered = false;
      logErr(`ask tool registration: ${errMessage(e)}`);
    }
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
    // Telegram unreachable: let the terminal dialog run instead of losing the question.
    if (!(await relayAsk({ pi, ctx, cfg, sessionId, away: true, input: event.input }))) {
      return undefined;
    }
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
    description: "Telegram bridge: status | away [on|off] | escalate <seconds|off> | test",
    handler: async (args, ctx) => {
      const [sub, arg] = args.trim().split(/\s+/);
      const say = (text: string) => ctx.ui?.notify?.(text, "info");
      // Re-read and store: running setup while this session is open should not
      // require a restart, and this command is the one path a user reaches for.
      // Leadership needs a heartbeat, so never activate where timers cannot run.
      if (!relay && (timersArmed || typeof ctx.setInterval === "function")) {
        ctxRef ??= ctx;
        sessionId ||= ctx.sessionManager?.getSessionId?.() ?? `pid${process.pid}`;
        cfg = loadConfig();
        if (activate()) {
          armTimers(ctx);
          tick();
        }
      }
      const current = cfg;
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
      if (sub === "escalate") {
        const seconds = arg === "off" ? 0 : Number(arg);
        if (!Number.isFinite(seconds) || seconds < 0) {
          say("Usage: /telegram escalate <seconds|off>");
          return;
        }
        cfg = { ...current, askEscalateMs: seconds > 0 ? Math.round(seconds * 1000) : undefined };
        saveConfig(cfg);
        if (cfg.askEscalateMs) registerAskTool();
        say(
          seconds > 0
            ? `Unanswered questions move to Telegram after ${seconds}s${askToolRegistered ? "" : " (restart omp to arm it)"}`
            : "Escalation off: questions stay in the terminal",
        );
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
      const poller = leader
        ? "this session"
        : readLeader()
          ? `another session (pid ${readLeader()?.pid})`
          : "none — restart omp if this persists";
      say(`${statusText().replace(/<[^>]+>/g, "")}\nrelay: ${relay ? "on" : "off"} · poller: ${poller}`);
    },
  });
}
