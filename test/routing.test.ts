import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { type RelayHandlers, routeUpdate } from "../src/relay";
import { readInbox, recordRouting, registerSession } from "../src/state";

const CFG: Config = { botToken: "1:TEST", chatId: "4242", allowedUserIds: [4242] };

interface Seen {
  undeliverable: string[];
}

function handlers(seen: Seen): RelayHandlers {
  return {
    async onCallback() { },
    async onAskText() {
      return false;
    },
    async onUndeliverable(_chatId, _replyTo, reason) {
      seen.undeliverable.push(reason);
    },
    async onCommand() {
      return false;
    },
  };
}

function bare(text: string, chatId = 4242) {
  return {
    update_id: 1,
    message: { message_id: 7, chat_id: chatId, text, from: { id: 4242 } },
  };
}

/** Runs `fn` against a private state directory, then tears it down. */
async function withState(fn: () => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "omp-tg-routing-"));
  const previous = process.env.OMP_TELEGRAM_DIR;
  process.env.OMP_TELEGRAM_DIR = join(root, "telegram");
  try {
    await fn();
  } finally {
    process.env.OMP_TELEGRAM_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("bare text reaches the newest live session, not the newest notification", async () => {
  await withState(async () => {
    // The older session is the only one that has ever notified, so it owns the
    // newest routing record. Targeting that record is what sent bare text to the
    // wrong session; the newer session must win on registration time alone.
    registerSession({ sessionId: "older", pid: process.pid, cwd: "/tmp", ts: 1_000 });
    recordRouting({ messageId: 900, sessionId: "older", ts: 1_000 });
    registerSession({ sessionId: "newer", pid: process.pid, cwd: "/tmp", ts: 2_000 });

    const seen: Seen = { undeliverable: [] };
    expect(await routeUpdate(CFG, bare("hello"), handlers(seen))).toBeUndefined();

    expect(seen.undeliverable).toEqual([]);
    expect(readInbox("newer").items.map((i) => i.text)).toEqual(["hello"]);
    expect(readInbox("older").items).toEqual([]);
  });
});

test("a session whose process died is not a target", async () => {
  await withState(async () => {
    // A pid that cannot be running: the record must be dropped rather than used.
    registerSession({ sessionId: "dead", pid: 2_147_483_646, cwd: "/tmp", ts: 1_000 });

    const seen: Seen = { undeliverable: [] };
    expect(await routeUpdate(CFG, bare("hello"), handlers(seen))).toBe("no routing target");
    expect(seen.undeliverable).toEqual(["No running session on this machine."]);
    expect(readInbox("dead").items).toEqual([]);
  });
});

test("bare text in a group is still refused, even with a live session", async () => {
  await withState(async () => {
    registerSession({ sessionId: "live", pid: process.pid, cwd: "/tmp", ts: 1_000 });

    const seen: Seen = { undeliverable: [] };
    expect(await routeUpdate(CFG, bare("group noise", -100_123), handlers(seen))).toBe(
      "bare text in group (reply to a notification instead)",
    );
    expect(readInbox("live").items).toEqual([]);
  });
});
