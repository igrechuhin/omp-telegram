import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BOT_COMMANDS, publishCommands } from "../src/commands";
import { saveConfig } from "../src/config";
import { isRecord } from "../src/guard";
import telegram from "../src/main";
import { readLeader, readOffset, writeOffset } from "../src/state";
import type { HookCtx, PiLike } from "../src/types";

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
    return Response.json({ ok: true, result: true });
  },
});

type Handler = (event: unknown, ctx: HookCtx) => unknown;

interface Fake {
  ctx: HookCtx;
  handlers: Map<string, Handler>;
  commands: Map<string, (args: string, ctx: HookCtx) => unknown>;
  timers: (() => unknown)[];
  sent: string[];
  entries: unknown[];
}

let dir = "";

function makeSession(id: string): Fake {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: HookCtx) => unknown>();
  const timers: (() => unknown)[] = [];
  const sent: string[] = [];
  const entries: unknown[] = [];
  const pi: PiLike = {
    on(event, handler) {
      handlers.set(event, handler as Handler);
    },
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
  };
  telegram(pi);
  return { ctx, handlers, commands, timers, sent, entries };
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

  test("leadership hands off on shutdown; replies to ended sessions are refused", async () => {
    b = makeSession("sessB");
    await emit(b, "session_start");
    expect(readLeader()?.sessionId).toBe("sessA");

    await emit(a, "session_shutdown");
    expect(readLeader()).toBeUndefined();
    b.timers[0]();
    expect(readLeader()?.sessionId).toBe("sessB");

    reply(11, notificationId, "are you there?");
    await polledPast(12);
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
    expect(commandNames(published.at(-1)?.body.commands)).toEqual(["status", "away"]);

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
});
