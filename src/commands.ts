import { paths, readJson, writeJsonAtomic } from "./config";
import { api } from "./tg";

/**
 * Telegram only shows a command menu for commands the bot has registered with
 * `setMyCommands`; implementing a handler is not enough. This is the single source
 * of truth for that list and for the `/` menu the client renders.
 */
export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: "status", description: "Machine, away mode, poller, allowed users" },
  { command: "away", description: "Questions here instead of the terminal: /away on|off" },
];

/** Changes whenever the published list does, so a stale menu is republished once. */
function fingerprint(): string {
  return BOT_COMMANDS.map((c) => `${c.command}:${c.description}`).join("|");
}

/**
 * Publishes the menu when it is missing or out of date. Returns true when a call
 * was made. Telegram clients cache the list, so republishing is cheap but not free;
 * the fingerprint keeps session start from calling it every time.
 */
export async function publishCommands(token: string, force = false): Promise<boolean> {
  const current = fingerprint();
  if (!force) {
    const saved = readJson(paths().commands);
    if (saved === current) return false;
  }
  const res = await api(token, "setMyCommands", { commands: BOT_COMMANDS });
  if (!res.ok) throw new Error(res.description ?? "setMyCommands failed");
  writeJsonAtomic(paths().commands, current);
  return true;
}
