import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BOT_COMMANDS, publishCommands } from "../src/commands";
import { loadConfig, saveConfig } from "../src/config";
import { isRecord } from "../src/guard";
import { ESCALATED_TEXT, askWithEscalation } from "../src/escalate";
import telegram from "../src/main";
import { readLeader, readOffset, writeOffset } from "../src/state";
import type {
  HookCtx,
  PiLike,
  SchemaLike,
  ToolCtx,
  ToolDefinitionLike,
  ToolResult,
} from "../src/types";

/**
 * Drives the real extension against a mock Telegram Bot API. Extension timers are
 * captured instead of scheduled, so each test steps the leader tick / inbox drain
 * explicitly. No test waits on wall-clock time: progress is observed through the
 * offset the leader sends on its next getUpdates, and through fs events.
 */

const TOKEN = "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz0123";
const ALLOWED = 4242;
const CHAT = 555;

interface Call {
  method: string;
  body: Record<string, unknown>;
}

const calls: Call[] = [];
const queue: Record<string, unknown>[] = [];
let lastMessageId = 1000;
let conflict = false;

/** Long-poll requests parked until an update is queued (or a conflict is injected). */
let held: (() => void)[] = [];
function releaseHeld(): void {
  const wake = held;
  held = [];
  for (const resolve of wake) resolve();
}

/** Highest offset the leader has asked for: it only asks for N after committing N-1. */
let polledOffset = 0;
let offsetWaiters: { min: number; resolve: () => void }[] = [];
function polledPast(min: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (polledOffset >= min) resolve();
  else offsetWaiters.push({ min, resolve });
  return promise;
}

function pendingFrom(offset: number): Record<string, unknown>[] {
  return queue.filter((u) => typeof u.update_id === "number" && u.update_id >= offset);
}

/** `getChat` replies keyed by user id, for `/status`'s name resolution. */
const CHAT_FIXTURES: Record<number, Record<string, unknown>> = {
  [ALLOWED]: { id: ALLOWED, username: "iv_an", first_name: "Ivan" },
};

const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split("/").pop() ?? "";
    const body: Record<string, unknown> = {};
    const type = req.headers.get("content-type") ?? "";
    if (type.includes("application/json")) {
      const parsed: unknown = await req.json();
      if (isRecord(parsed)) Object.assign(body, parsed);
    } else if (type.includes("multipart")) {
      for (const [key, value] of await req.formData()) {
        body[key] = typeof value === "string" ? value : "<file>";
      }
    }
    if (method === "getUpdates") {
      const offset = typeof body.offset === "number" ? body.offset : 0;
      polledOffset = Math.max(polledOffset, offset);
      const ready = offsetWaiters.filter((w) => polledOffset >= w.min);
      offsetWaiters = offsetWaiters.filter((w) => polledOffset < w.min);
      for (const w of ready) w.resolve();

      if (!conflict && !pendingFrom(offset).length) {
        const { promise, resolve } = Promise.withResolvers<void>();
        held.push(resolve);
        await promise;
      }
      if (conflict) {
        return Response.json(
          { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" },
          { status: 409 },
        );
      }
      return Response.json({ ok: true, result: pendingFrom(offset) });
    }
    calls.push({ method, body });
    if (method === "sendMessage" || method === "sendDocument") {
      lastMessageId++;
      return Response.json({ ok: true, result: { message_id: lastMessageId, chat: { id: CHAT } } });
    }
    if (method === "getChat") {
      // `/status` resolves each allowed id to a display name through this call. Ids without a
      // fixture answer the way Telegram does for a chat the bot has never seen.
      const chat = CHAT_FIXTURES[Number(body.chat_id)];
      if (!chat) {
        return Response.json(
          { ok: false, error_code: 400, description: "Bad Request: chat not found" },
          { status: 400 },
        );
      }
      return Response.json({ ok: true, result: chat });
    }
    return Response.json({ ok: true, result: true });
  },
});

type Handler = (event: unknown, ctx: HookCtx) => unknown;

interface Fake {
  ctx: HookCtx;
  handlers: Map<string, Handler>;
  commands: Map<string, (args: string, ctx: HookCtx) => unknown>;
  tools: Map<string, ToolDefinitionLike>;
  timers: (() => unknown)[];
  sent: string[];
  entries: unknown[];
  shutdowns: number;
}

let dir = "";

function makeSession(id: string): Fake {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: HookCtx) => unknown>();
  const tools = new Map<string, ToolDefinitionLike>();
  const timers: (() => unknown)[] = [];
  const sent: string[] = [];
  const entries: unknown[] = [];
  const pi: PiLike = {
    on(event, handler) {
      handlers.set(event, handler as Handler);
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    // Only the chainable shape matters here: the host validates for real.
    zod: (() => {
      const schema: SchemaLike = { optional: () => schema, describe: () => schema };
      return { object: () => schema, array: () => schema, string: () => schema, number: () => schema, boolean: () => schema };
    })(),
    registerCommand(name, opts) {
      commands.set(name, opts.handler);
    },
    async exec(command, args) {
      return { stdout: Bun.spawnSync([command, ...args]).stdout.toString() };
    },
    sendUserMessage(content) {
      sent.push(content);
    },
    getSessionName: () => "Fix login flow",
  };
  const ctx: HookCtx = {
    cwd: dir,
    mode: "tui",
    hasUI: true,
    agent: { kind: "main" },
    sessionManager: { getBranch: () => entries, getSessionId: () => id },
    ui: { notify: () => {} },
    setInterval: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    isIdle: () => true,
    shutdown: () => {
      fake.shutdowns++;
    },
  };
  telegram(pi);
  const fake: Fake = { ctx, handlers, commands, tools, timers, sent, entries, shutdowns: 0 };
  return fake;
}

async function emit(s: Fake, event: string, payload: unknown = {}): Promise<unknown> {
  return await s.handlers.get(event)?.(payload, s.ctx);
}

/** Resolves when the leader lock file disappears. */
function leaderGone(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const watcher = watch(join(dir, "tg", "state"), () => {
    if (!readLeader()) {
      watcher.close();
      resolve();
    }
  });
  if (!readLeader()) {
    watcher.close();
    resolve();
  }
  return promise;
}

function sends(method = "sendMessage"): Call[] {
  return calls.filter((c) => c.method === method);
}

function lastSendText(): string {
  const text = sends().at(-1)?.body.text;
  return typeof text === "string" ? text : "";
}

function keyboardData(body: Record<string, unknown> | undefined): string[] {
  const markup = body?.reply_markup;
  if (!isRecord(markup) || !Array.isArray(markup.inline_keyboard)) return [];
  const out: string[] = [];
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) continue;
    for (const button of row) {
      if (isRecord(button) && typeof button.callback_data === "string") out.push(button.callback_data);
    }
  }
  return out;
}

function assistant(text: string, stopReason = "stop"): unknown {
  return { type: "message", message: { role: "assistant", content: [{ type: "text", text }], stopReason } };
}

function reply(updateId: number, to: number | undefined, text: string, from = ALLOWED, chat = CHAT) {
  queue.push({
    update_id: updateId,
    message: {
      message_id: 10_000 + updateId,
      chat: { id: chat },
      from: { id: from },
      text,
      ...(to !== undefined ? { reply_to_message: { message_id: to } } : {}),
    },
  });
  releaseHeld();
}

function tap(updateId: number, data: string, messageId: number) {
  queue.push({
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      data,
      from: { id: ALLOWED },
      message: { message_id: messageId, chat: { id: CHAT } },
    },
  });
  releaseHeld();
}

let a: Fake;
let b: Fake | undefined;
let notificationId = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "omp-tg-"));
  process.env.OMP_TELEGRAM_DIR = join(dir, "tg");
  process.env.OMP_TELEGRAM_API_BASE = `http://localhost:${server.port}`;
  saveConfig({
    botToken: TOKEN,
    chatId: String(CHAT),
    allowedUserIds: [ALLOWED],
    machineName: "testbox",
    notifyNonInteractive: true,
  });
  a = makeSession("sessA");
  await emit(a, "session_start");
});

afterAll(async () => {
  if (b) await emit(b, "session_shutdown");
  await emit(a, "session_shutdown");
  releaseHeld();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("telegram bridge", () => {
  test("stop notification is structured, escaped, and routable", async () => {
    expect(readLeader()?.sessionId).toBe("sessA");
    a.entries.push({ type: "message", message: { role: "user", timestamp: Date.now() - 65_000 } });
    a.entries.push(assistant("Fixed <Login> & tests pass"));
    await emit(a, "session_stop");
    notificationId = lastMessageId;

    expect(sends().at(-1)?.body.parse_mode).toBe("HTML");
    const text = lastSendText();
    expect(text).toContain(`🟢 <b>Done</b> · ${basename(dir)}`);
    expect(text).toContain("📝 Fix login flow");
    expect(text).toContain("testbox");
    expect(text).toMatch(/⏱ 1m0[56]s/);
    expect(text).toContain("<blockquote expandable>Fixed &lt;Login&gt; &amp; tests pass</blockquote>");
    expect(existsSync(join(dir, "tg", "state", "routing", `${notificationId}.json`))).toBe(true);
  });

  test("error stop is labelled as failed", async () => {
    a.entries.push({
      type: "message",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" },
    });
    await emit(a, "session_stop");
    expect(lastSendText()).toContain("🔴 <b>Failed</b>");
    expect(lastSendText()).toContain("rate limited");
  });

  test("reply to a notification is injected into its session", async () => {
    reply(1, notificationId, "also update the README");
    await polledPast(2);
    a.timers[1]();
    expect(a.sent).toEqual(["[via Telegram] also update the README"]);
  });

  test("messages from other users never reach the session and get no reply", async () => {
    const before = sends().length;
    reply(2, notificationId, "rm -rf ~", 999);
    // A stranger's command must not be answered either: a reply would confirm
    // to them that this bot is live and listening. Ids stay in sequence so the
    // later tests' updates are still delivered.
    reply(3, undefined, "/status", 999);
    await polledPast(4);
    a.timers[1]();
    expect(a.sent).toHaveLength(1);
    expect(sends().length).toBe(before);
    expect(readFileSync(join(dir, "tg", "state", "err.log"), "utf8")).toContain("unauthorized");
  });

  test("bare text routes only in a private chat", async () => {
    reply(4, undefined, "group noise", ALLOWED, -100123);
    reply(5, undefined, "private hello");
    await polledPast(6);
    a.timers[1]();
    expect(a.sent.at(-1)).toBe("[via Telegram] private hello");
    expect(a.sent.join("\n")).not.toContain("group noise");
  });

  test("long response is truncated and attached in full", async () => {
    a.entries.push(assistant("x".repeat(5000)));
    await emit(a, "session_stop");
    expect(lastSendText()).toContain("full text attached");
    expect(sends("sendDocument")).toHaveLength(1);
    expect(sends("sendDocument")[0].body.document).toBe("<file>");
  });

  test("away-mode ask goes to Telegram and answers come back as one message", async () => {
    await a.commands.get("telegram")?.("away on", a.ctx);
    const result = await emit(a, "tool_call", {
      toolName: "ask",
      input: {
        questions: [
          { id: "db", question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] },
          {
            id: "extras",
            question: "Extras?",
            multi: true,
            options: [{ label: "Redis" }, { label: "Kafka" }, { label: "S3" }],
          },
        ],
      },
    });
    expect(isRecord(result) && result.block).toBe(true);
    const askMessage = lastMessageId;
    const first = keyboardData(sends().at(-1)?.body);
    expect(first).toHaveLength(2);
    expect(first[1]).toMatch(/^a:[a-z0-9]+:0:1$/);

    // The relayed question replaces the end-of-turn ping.
    const before = sends().length;
    await emit(a, "session_stop");
    expect(sends().length).toBe(before);

    tap(6, first[1], askMessage);
    await polledPast(7);
    const secondMessage = lastMessageId;
    const second = keyboardData(sends().at(-1)?.body);
    expect(second).toHaveLength(4);
    expect(second[3]).toMatch(/^d:/);

    tap(7, second[0], secondMessage);
    tap(8, second[2], secondMessage);
    tap(9, second[3], secondMessage);
    await polledPast(10);
    a.timers[1]();
    const answer = a.sent.at(-1) ?? "";
    expect(answer).toContain("Which database? → Postgres");
    expect(answer).toContain("Extras? → Redis, S3");

    tap(10, first[1], askMessage);
    await polledPast(11);
    expect(sends("answerCallbackQuery").at(-1)?.body.text).toBe("Already answered.");
    await a.commands.get("telegram")?.("away off", a.ctx);
  });

  test("bare /exit is refused: it must name a session by replying", async () => {
    reply(11, undefined, "/exit");
    await polledPast(12);
    await a.timers[1]();
    expect(a.shutdowns).toBe(0);
    expect(lastSendText()).toContain("reply /exit to one of its notifications");
  });

  test("/exit replied to a notification ends that session, once", async () => {
    const injected = a.sent.length;
    reply(12, notificationId, "/exit");
    await polledPast(13);
    await a.timers[1]();
    expect(a.shutdowns).toBe(1);
    expect(lastSendText()).toContain("Ending session");
    // Intercepted, never injected as a prompt.
    expect(a.sent).toHaveLength(injected);
    await a.timers[1]();
    expect(a.shutdowns).toBe(1);
  });

  test("/status names each allowed user with a tappable link", async () => {
    reply(13, undefined, "/status");
    await polledPast(14);
    const body = sends().at(-1)?.body;
    const text = typeof body?.text === "string" ? body.text : "";
    // The id alone names nobody and cannot be tapped; the resolved username must carry a link.
    expect(text).toContain('👤 allowed users: <a href="https://t.me/iv_an">@iv_an</a>');
    expect(text).not.toContain(`allowed users: ${ALLOWED}`);
    expect(body?.parse_mode).toBe("HTML");
    // A t.me link would otherwise pull a preview card onto every status reply.
    expect(body?.link_preview_options).toEqual({ is_disabled: true });
    expect(sends("getChat")).not.toHaveLength(0);
  });

  test("leadership hands off on shutdown; replies to ended sessions are refused", async () => {
    b = makeSession("sessB");
    await emit(b, "session_start");
    expect(readLeader()?.sessionId).toBe("sessA");

    await emit(a, "session_shutdown");
    expect(readLeader()).toBeUndefined();
    b.timers[0]();
    expect(readLeader()?.sessionId).toBe("sessB");

    reply(15, notificationId, "are you there?");
    await polledPast(16);
    expect(lastSendText()).toContain("That session has ended.");
  });

  test("a competing getUpdates reader makes the leader step down", async () => {
    const gone = leaderGone();
    conflict = true;
    releaseHeld();
    await gone;
    conflict = false;
    expect(readFileSync(join(dir, "tg", "state", "err.log"), "utf8")).toContain("getUpdates conflict");
  });
});

describe("state directory creation", () => {
  /**
   * Setup writes the Telegram offset before any session has run `ensureDirs`, so
   * an atomic write whose parent is missing crashed setup with ENOENT.
   */
  test("writeOffset creates state/ when nothing has run before it", () => {
    const fresh = mkdtempSync(join(tmpdir(), "omp-tg-fresh-"));
    const previous = process.env.OMP_TELEGRAM_DIR;
    process.env.OMP_TELEGRAM_DIR = join(fresh, "telegram");
    try {
      expect(existsSync(join(fresh, "telegram", "state"))).toBe(false);
      writeOffset(77);
      expect(readOffset()).toBe(77);
    } finally {
      process.env.OMP_TELEGRAM_DIR = previous;
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe("command menu", () => {
  /**
   * Telegram renders the `/` menu only from setMyCommands; handling a command is
   * not enough. The fingerprint keeps every session start from re-publishing.
   */
  function commandNames(sent: unknown): string[] {
    if (!Array.isArray(sent)) return [];
    return sent.map((c) => (isRecord(c) && typeof c.command === "string" ? c.command : ""));
  }

  test("the leader publishes the menu when it takes leadership", () => {
    // sessA won leadership in beforeAll; publishing is what makes the `/` menu
    // appear without re-running setup.
    expect(calls.some((c) => c.method === "setMyCommands")).toBe(true);
    expect(existsSync(join(dir, "tg", "state", "commands.json"))).toBe(true);
  });

  test("publishes once, then only when the list changes", async () => {
    // The leader may already have published during earlier tests; start from a
    // known state so this asserts the fingerprint logic, not the run order.
    rmSync(join(dir, "tg", "state", "commands.json"), { force: true });
    const before = calls.filter((c) => c.method === "setMyCommands").length;
    expect(await publishCommands(TOKEN)).toBe(true);
    const published = calls.filter((c) => c.method === "setMyCommands");
    expect(published).toHaveLength(before + 1);
    expect(commandNames(published.at(-1)?.body.commands)).toEqual(["status", "away", "exit"]);

    expect(await publishCommands(TOKEN)).toBe(false);
    expect(calls.filter((c) => c.method === "setMyCommands")).toHaveLength(before + 1);

    expect(await publishCommands(TOKEN, true)).toBe(true);
    expect(calls.filter((c) => c.method === "setMyCommands")).toHaveLength(before + 2);
  });

  test("every command the bot answers is in the published menu", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    const handled = new Set<string>();
    for (const m of source.matchAll(/cmd === "\/(\w+)"/g)) handled.add(m[1] ?? "");
    // /start is Telegram's own entry point and is deliberately not listed.
    handled.delete("start");
    const listed = new Set(BOT_COMMANDS.map((c) => c.command));
    expect([...handled].filter((c) => !listed.has(c))).toEqual([]);
  });
});

describe("configuration after session start", () => {
  /**
   * A session started before setup ran must still relay once the config exists:
   * `start` used to load config once and return permanently, so commands were
   * never polled until the session was restarted.
   */
  test("a session started without config activates when setup lands", async () => {
    const late = mkdtempSync(join(tmpdir(), "omp-tg-late-"));
    const previous = process.env.OMP_TELEGRAM_DIR;
    process.env.OMP_TELEGRAM_DIR = join(late, "tg");
    const savedDir = dir;
    dir = late;
    try {
      const c = makeSession("sessLate");
      await emit(c, "session_start");
      // No config yet: nothing registered and no leader, but timers are armed.
      expect(readLeader()).toBeUndefined();
      expect(c.timers.length).toBeGreaterThan(0);

      saveConfig({
        botToken: TOKEN,
        chatId: String(CHAT),
        allowedUserIds: [ALLOWED],
        machineName: "latebox",
        notifyNonInteractive: true,
      });
      c.timers[0]();
      expect(readLeader()?.sessionId).toBe("sessLate");
      await emit(c, "session_shutdown");
    } finally {
      dir = savedDir;
      process.env.OMP_TELEGRAM_DIR = previous;
      rmSync(late, { recursive: true, force: true });
    }
  });

  test("/telegram status activates the relay without waiting for a tick", async () => {
    const late = mkdtempSync(join(tmpdir(), "omp-tg-cmd-"));
    const previous = process.env.OMP_TELEGRAM_DIR;
    process.env.OMP_TELEGRAM_DIR = join(late, "tg");
    const savedDir = dir;
    dir = late;
    try {
      const c = makeSession("sessCmd");
      await emit(c, "session_start");
      expect(readLeader()).toBeUndefined();

      saveConfig({
        botToken: TOKEN,
        chatId: String(CHAT),
        allowedUserIds: [ALLOWED],
        machineName: "cmdbox",
        notifyNonInteractive: true,
      });
      // Running the command is what a user does when nothing happens; it must
      // pick up the new config instead of reporting "Not configured".
      await c.commands.get("telegram")?.("status", c.ctx);
      expect(readLeader()?.sessionId).toBe("sessCmd");
      await emit(c, "session_shutdown");
    } finally {
      dir = savedDir;
      process.env.OMP_TELEGRAM_DIR = previous;
      rmSync(late, { recursive: true, force: true });
    }
  });
});

describe("ask timeout escalation", () => {
  /**
   * `askWithEscalation` owns the race between the terminal dialog and the relay.
   * These drive it directly: the dialog is `ctx.invokeTool`, so a test controls
   * exactly when (and whether) the user answers.
   */

  const QUESTIONS = {
    questions: [{ id: "db", question: "Which database?", options: [{ label: "SQLite" }] }],
  };

  function answered(text: string): ToolResult {
    return { content: [{ type: "text", text }] };
  }

  /** A dialog that never resolves until aborted, like an unwatched terminal. */
  function unwatchedDialog(): { ctx: ToolCtx; aborted: () => boolean } {
    let seen: AbortSignal | undefined;
    return {
      aborted: () => seen?.aborted === true,
      ctx: {
        invokeTool: (_params, options) =>
          new Promise((_resolve, reject) => {
            seen = options?.signal;
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      },
    };
  }

  test("a terminal answer wins and is returned verbatim, with no relay", async () => {
    let relays = 0;
    const result = await askWithEscalation(
      QUESTIONS,
      undefined,
      undefined,
      { invokeTool: async () => answered("SQLite") },
      {
        escalateMs: () => 10,
        escalate: async () => {
          relays++;
          return true;
        },
      },
    );
    expect(result.content[0].text).toBe("SQLite");
    expect(relays).toBe(0);
  });

  test("an unanswered dialog is aborted and the question is relayed", async () => {
    const dialog = unwatchedDialog();
    let relayed: unknown;
    const result = await askWithEscalation(QUESTIONS, undefined, undefined, dialog.ctx, {
      escalateMs: () => 5,
      escalate: async (input) => {
        relayed = input;
        return true;
      },
    });
    expect(result.content[0].text).toBe(ESCALATED_TEXT);
    expect(isRecord(result.details) && result.details.escalated).toBe(true);
    // The losing channel must be destroyed, or it could answer later too.
    expect(dialog.aborted()).toBe(true);
    expect(relayed).toEqual(QUESTIONS);
  });

  test("an undeliverable relay reopens the dialog instead of losing the question", async () => {
    let opened = 0;
    const result = await askWithEscalation(
      QUESTIONS,
      undefined,
      undefined,
      {
        invokeTool: (_params, options) => {
          opened++;
          // First open: never answered, so escalation fires. Second: answered.
          if (opened > 1) return Promise.resolve(answered("SQLite"));
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      },
      { escalateMs: () => 5, escalate: async () => false },
    );
    expect(result.content[0].text).toBe("SQLite");
    expect(opened).toBe(2);
  });

  test("escalateMs 0 passes straight through to the native dialog", async () => {
    let passedSignal: AbortSignal | undefined;
    const outer = new AbortController();
    const result = await askWithEscalation(
      QUESTIONS,
      outer.signal,
      undefined,
      {
        invokeTool: async (_params, options) => {
          passedSignal = options?.signal;
          return answered("SQLite");
        },
      },
      {
        escalateMs: () => 0,
        escalate: async () => true,
      },
    );
    expect(result.content[0].text).toBe("SQLite");
    // No wrapper controller: the host's own signal reaches the dialog untouched.
    expect(passedSignal).toBe(outer.signal);
  });

  test("an interrupt surfaces the host's cancellation rather than relaying", async () => {
    const outer = new AbortController();
    const dialog = unwatchedDialog();
    let relays = 0;
    const pending = askWithEscalation(QUESTIONS, outer.signal, undefined, dialog.ctx, {
      escalateMs: () => 10_000,
      escalate: async () => {
        relays++;
        return true;
      },
    });
    outer.abort(new Error("user interrupted"));
    await expect(pending).rejects.toThrow("aborted");
    expect(relays).toBe(0);
  });


  test("an answer landing as the dialog is aborted still wins over the relay", async () => {
    let relays = 0;
    const result = await askWithEscalation(
      QUESTIONS,
      undefined,
      undefined,
      {
        // Resolves *because* of the abort: the user committed in the instant between
        // the deadline firing and the cancellation landing.
        invokeTool: (_params, options) =>
          new Promise((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve(answered("SQLite")), { once: true });
          }),
      },
      {
        escalateMs: () => 5,
        escalate: async () => {
          relays++;
          return true;
        },
      },
    );
    // Both channels must never be live: a delivered answer cancels the relay.
    expect(result.content[0].text).toBe("SQLite");
    expect(relays).toBe(0);
  });


  test("a signal already aborted before the call never opens a live dialog", async () => {
    const outer = new AbortController();
    outer.abort(new Error("interrupted before ask"));
    let sawAborted: boolean | undefined;
    let relays = 0;
    // `addEventListener` never fires for an already-aborted signal, so without the
    // pre-check the dialog would run uncancelled and this call could never settle.
    await expect(
      askWithEscalation(
        QUESTIONS,
        outer.signal,
        undefined,
        {
          invokeTool: (_params, options) => {
            sawAborted = options?.signal?.aborted;
            return Promise.reject(new Error("Ask input was cancelled"));
          },
        },
        {
          escalateMs: () => 5,
          escalate: async () => {
            relays++;
            return true;
          },
        },
      ),
    ).rejects.toThrow("Ask input was cancelled");
    expect(sawAborted).toBe(true);
    expect(relays).toBe(0);
  });

  test("a session with no prompt surface reports that ask is unavailable", async () => {
    await expect(
      askWithEscalation(QUESTIONS, undefined, undefined, {}, { escalateMs: () => 5, escalate: async () => true }),
    ).rejects.toThrow("no interactive prompt surface");
  });

  test("a cancelled dialog propagates the cancellation instead of relaying", async () => {
    let relays = 0;
    await expect(
      askWithEscalation(
        QUESTIONS,
        undefined,
        undefined,
        { invokeTool: () => Promise.reject(new Error("Ask tool was cancelled by the user")) },
        {
          escalateMs: () => 10_000,
          escalate: async () => {
            relays++;
            return true;
          },
        },
      ),
    ).rejects.toThrow("cancelled by the user");
    // Declining to answer is an answer: it must not reroute the question.
    expect(relays).toBe(0);
  });

  test("an interrupt inside the escalation window propagates instead of relaying", async () => {
    const outer = new AbortController();
    let relays = 0;
    // Ordering, without depending on which of two timers fires first:
    //   1. the dialog opens and never settles on its own;
    //   2. the interrupt aborts it, which the dialog observes but does not act on;
    //   3. the 1ms deadline therefore wins the race with `signal.aborted` already true;
    //   4. only then is the dialog allowed to reject.
    const gate = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    const pending = askWithEscalation(
      QUESTIONS,
      outer.signal,
      undefined,
      {
        invokeTool: (_params, options) => {
          options?.signal?.addEventListener("abort", () => observed.resolve(), { once: true });
          return gate.promise.then(() => {
            throw new Error("Ask input was cancelled");
          });
        },
      },
      {
        escalateMs: () => 1,
        escalate: async () => {
          relays++;
          return true;
        },
      },
    );
    outer.abort(new Error("user interrupted"));
    // Bounded: if abort propagation regressed, this fails fast instead of hanging.
    await Promise.race([
      observed.promise,
      new Promise((_r, reject) => setTimeout(() => reject(new Error("dialog never observed the abort")), 2_000)),
    ]);
    // Outlasts the 1ms deadline by two orders of magnitude, so it has certainly fired
    // while the dialog was still held open.
    await new Promise((resolve) => setTimeout(resolve, 100));
    gate.resolve();
    await expect(pending).rejects.toThrow("Ask input was cancelled");
    // The interrupt is not an unanswered question: it must never reach Telegram.
    expect(relays).toBe(0);
  });
});

describe("escalation wiring", () => {
  /**
   * Covers what the unit tests cannot: that `/telegram escalate` registers the
   * shadowing tool on a session whose relay is already active, that the registered
   * tool actually relays through Telegram, and that the schema accepts every field
   * the native tool accepts.
   */
  test("/telegram escalate arms the tool, which then relays a stalled question", async () => {
    expect(a.tools.has("ask")).toBe(false);
    // `a` already relays, so this exercises the path that skips re-activation.
    await a.commands.get("telegram")?.("escalate 0.01", a.ctx);
    const tool = a.tools.get("ask");
    expect(tool).toBeDefined();
    if (!tool) return;
    expect(tool.approval).toBe("read");
    expect(tool.concurrency).toBe("exclusive");

    const before = sends().length;
    const result = await tool.execute(
      "call-1",
      {
        questions: [
          {
            id: "db",
            question: "Which database?",
            header: "Storage",
            recommended: 0,
            options: [
              { label: "SQLite", description: "file-backed" },
              // `preview` is accepted for native parity even though Telegram drops it.
              { label: "Postgres", preview: "server" },
            ],
          },
        ],
      },
      undefined,
      undefined,
      {
        invokeTool: (_params, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      },
    );

    expect(result.content[0].text).toBe(ESCALATED_TEXT);
    expect(sends().length).toBe(before + 1);
    const relayed = sends().at(-1);
    expect(relayed?.body.text).toContain("Which database?");
    // Escalation is not away mode: no 🌙 chip, but the buttons are there.
    expect(relayed?.body.text).not.toContain("🌙 away");
    expect(keyboardData(relayed?.body)).toHaveLength(2);

    // The relay replaces the end-of-turn ping, exactly as away mode does.
    const afterRelay = sends().length;
    await emit(a, "session_stop");
    expect(sends().length).toBe(afterRelay);

    await a.commands.get("telegram")?.("escalate off", a.ctx);
    expect(loadConfig()?.askEscalateMs).toBeUndefined();
    // Disarmed: the tool stays registered but now passes straight through.
    const passthrough = await tool.execute("call-2", { questions: [] }, undefined, undefined, {
      invokeTool: async () => ({ content: [{ type: "text" as const, text: "native" }] }),
    });
    expect(passthrough.content[0].text).toBe("native");
  });

  test("an escalated multi-select question relays toggles and answers back", async () => {
    await a.commands.get("telegram")?.("escalate 0.01", a.ctx);
    const tool = a.tools.get("ask");
    expect(tool).toBeDefined();
    if (!tool) return;

    const result = await tool.execute(
      "call-multi",
      {
        questions: [
          {
            id: "extras",
            question: "Extras?",
            multi: true,
            options: [{ label: "Redis" }, { label: "Kafka" }, { label: "S3" }],
          },
        ],
      },
      undefined,
      undefined,
      {
        invokeTool: (_params, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      },
    );
    expect(result.content[0].text).toBe(ESCALATED_TEXT);

    const askMessage = lastMessageId;
    const buttons = keyboardData(sends().at(-1)?.body);
    // Three toggles plus Done, and toggles use `t:` rather than the single-select `a:`.
    expect(buttons).toHaveLength(4);
    expect(buttons[0]).toMatch(/^t:[a-z0-9]+:0:0$/);
    expect(buttons[3]).toMatch(/^d:/);
    expect(sends().at(-1)?.body.text).toContain("Toggle options, then ✅ Done");

    tap(90, buttons[0], askMessage);
    tap(91, buttons[2], askMessage);
    tap(92, buttons[3], askMessage);
    await polledPast(93);
    a.timers[1]();
    expect(a.sent.at(-1) ?? "").toContain("Extras? → Redis, S3");

    await a.commands.get("telegram")?.("escalate off", a.ctx);
  });
});
