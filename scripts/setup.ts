#!/usr/bin/env bun
/**
 * Per-machine setup: verifies a bot token, discovers your Telegram user id and the
 * target chat from a `/start` you send, writes a 0600 config, and disables the
 * legacy `hooks/post/telegram-notify.ts` hook (moved, not deleted).
 *
 * Non-interactive: --token T --chat C --user U [--machine NAME] [--yes]
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type Config, loadConfig, paths, saveConfig } from "../src/config";
import { isRecord } from "../src/guard";
import { writeOffset } from "../src/state";
import { api, asUpdates } from "../src/tg";

const LEGACY_HOOK = join(homedir(), ".omp", "agent", "hooks", "post", "telegram-notify.ts");
const LEGACY_PARKED = join(homedir(), ".omp", "agent", "hooks", "telegram-notify.ts.disabled");
const DISCOVERY_DEADLINE_MS = 5 * 60_000;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const yes = process.argv.includes("--yes");
const rl = createInterface({ input: process.stdin, output: process.stdout });

async function prompt(question: string, fallback?: string): Promise<string> {
  const answer = (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim();
  return answer || fallback || "";
}

async function confirm(question: string): Promise<boolean> {
  if (yes) return true;
  return /^y(es)?$/i.test(await prompt(`${question} (y/N)`));
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  rl.close();
  process.exit(1);
}

async function discover(token: string, botName: string): Promise<{ chatId: string; userId: number }> {
  console.log(
    [
      "",
      "Send a message so I can learn your user id and the chat:",
      `  • private chat: open https://t.me/${botName} and press Start`,
      `  • shared group: add @${botName} to the group, then send /start@${botName} there`,
      "Waiting up to 5 minutes…",
    ].join("\n"),
  );
  let offset: number | undefined;
  const deadline = Date.now() + DISCOVERY_DEADLINE_MS;
  while (Date.now() < deadline) {
    const res = await api(token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, 35_000);
    if (!res.ok) fail(`getUpdates: ${res.description}`);
    for (const update of asUpdates(res.result)) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg?.from || !msg.text?.startsWith("/start")) continue;
      // Acknowledge so the plugin's poller does not see this /start again.
      await api(token, "getUpdates", { offset, timeout: 0 });
      writeOffset(offset);
      console.log(`✓ Got /start from user ${msg.from.id}${msg.from.username ? ` (@${msg.from.username})` : ""} in chat ${msg.chat_id}`);
      return { chatId: String(msg.chat_id), userId: msg.from.id };
    }
  }
  fail("No /start received in time. Re-run setup.");
}

async function main(): Promise<void> {
  const existing = loadConfig();
  const token = flag("token") ?? (await prompt("Bot token from @BotFather (one bot per machine)", existing?.botToken ? "keep current" : undefined));
  const botToken = token === "keep current" && existing ? existing.botToken : token;
  if (!/^\d+:[\w-]{30,}$/.test(botToken)) fail("That does not look like a bot token.");

  const me = await api(botToken, "getMe");
  if (!me.ok || !isRecord(me.result) || typeof me.result.username !== "string") {
    fail(`Token rejected: ${me.description ?? "unexpected getMe response"}`);
  }
  const botName = me.result.username;
  console.log(`✓ Bot @${botName}`);
  if (me.result.can_read_all_group_messages === true) {
    console.warn(
      "⚠ Privacy mode is OFF for this bot. In a shared group it would see other machines' traffic.\n" +
        "  Fix: @BotFather → /mybots → this bot → Bot Settings → Group Privacy → Turn on.",
    );
  }
  const hook = await api(botToken, "getWebhookInfo");
  if (hook.ok && isRecord(hook.result) && typeof hook.result.url === "string" && hook.result.url) {
    fail(`Bot has a webhook (${hook.result.url}); getUpdates cannot run alongside it. Use a dedicated bot.`);
  }

  const chatFlag = flag("chat");
  const userFlag = flag("user");
  const found =
    chatFlag && userFlag ? { chatId: chatFlag, userId: Number(userFlag) } : await discover(botToken, botName);
  if (!Number.isSafeInteger(found.userId) || found.userId <= 0) fail("Invalid user id.");

  const cfg: Config = {
    botToken,
    chatId: found.chatId,
    allowedUserIds: [found.userId],
    machineName: flag("machine") ?? (yes ? hostname().split(".")[0] : await prompt("Machine label", existing?.machineName ?? hostname().split(".")[0])),
    notifyNonInteractive: existing?.notifyNonInteractive ?? true,
  };
  saveConfig(cfg);
  console.log(`✓ Config written: ${paths().config} (0600)`);

  const test = await api(botToken, "sendMessage", {
    chat_id: cfg.chatId,
    text: `✅ omp-telegram connected on ${cfg.machineName}. Reply to agent notifications to continue a session.`,
  });
  if (!test.ok) fail(`Test message failed: ${test.description}`);
  console.log("✓ Test message sent");

  if (existsSync(LEGACY_HOOK) && (await confirm(`Disable legacy hook ${LEGACY_HOOK}? (moved to ${LEGACY_PARKED})`))) {
    mkdirSync(join(homedir(), ".omp", "agent", "hooks"), { recursive: true });
    renameSync(LEGACY_HOOK, LEGACY_PARKED);
    console.log("✓ Legacy hook disabled");
  }
  console.log("\nDone. Restart running omp sessions to load the plugin.");
  rl.close();
}

await main();
