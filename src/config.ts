import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "./guard";

export interface Paths {
  root: string;
  state: string;
  config: string;
  err: string;
  leader: string;
  offset: string;
  away: string;
  sessions: string;
  routing: string;
  inbox: string;
  asks: string;
}

/**
 * Resolved per call so the setup script and tests can set OMP_TELEGRAM_DIR
 * before any state is touched.
 */
export function paths(): Paths {
  const root = process.env.OMP_TELEGRAM_DIR || join(homedir(), ".omp", "agent", "telegram");
  const state = join(root, "state");
  return {
    root,
    state,
    config: join(root, "config.json"),
    err: join(state, "err.log"),
    leader: join(state, "leader.json"),
    offset: join(state, "offset.json"),
    away: join(state, "away.json"),
    sessions: join(state, "sessions"),
    routing: join(state, "routing"),
    inbox: join(state, "inbox"),
    asks: join(state, "asks"),
  };
}

/** Ids reach the filesystem as file names, so they are sanitized first. */
export function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96);
}

/** File-naming contract for per-session and per-message state. */
export const stateFile = {
  inbox: (sessionId: string) => join(paths().inbox, `${safeId(sessionId)}.jsonl`),
  cursor: (sessionId: string) => join(paths().inbox, `${safeId(sessionId)}.cursor`),
  session: (sessionId: string) => join(paths().sessions, `${safeId(sessionId)}.json`),
  routing: (messageId: number) => join(paths().routing, `${messageId}.json`),
  ask: (askId: string) => join(paths().asks, `${safeId(askId)}.json`),
};

/** Telegram API origin; overridable so tests can drive a mock server. */
export function apiBase(): string {
  return process.env.OMP_TELEGRAM_API_BASE || "https://api.telegram.org";
}

export interface Config {
  botToken: string;
  chatId: string;
  /** Telegram user ids allowed to drive the agent. Empty disables reply relay. */
  allowedUserIds: number[];
  /** Label shown in notifications; defaults to the short hostname. */
  machineName?: string;
  /** Notify for print/json/rpc runs too. Default true, matching the old hook. */
  notifyNonInteractive?: boolean;
}

export function ensureDirs(): void {
  const p = paths();
  for (const dir of [p.root, p.state, p.sessions, p.routing, p.inbox, p.asks]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function parseConfig(raw: unknown): Config | null {
  if (!isRecord(raw)) return null;
  const { botToken, chatId } = raw;
  if (typeof botToken !== "string" || !botToken) return null;
  if (typeof chatId !== "string" && typeof chatId !== "number") return null;
  const allowedUserIds = Array.isArray(raw.allowedUserIds)
    ? raw.allowedUserIds.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0)
    : [];
  return {
    botToken,
    chatId: String(chatId),
    allowedUserIds,
    machineName: typeof raw.machineName === "string" && raw.machineName ? raw.machineName : undefined,
    notifyNonInteractive: raw.notifyNonInteractive !== false,
  };
}

export function loadConfig(): Config | null {
  return parseConfig(readJson(paths().config));
}

export function saveConfig(cfg: Config): void {
  writeJsonAtomic(paths().config, cfg);
  chmodSync(paths().config, 0o600);
}

export function machineName(cfg: Config | null): string {
  return cfg?.machineName || hostname().split(".")[0];
}

/** Creates the parent directory, so callers need no ordering against `ensureDirs`. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Parsed JSON or `undefined` when missing/corrupt; callers validate the shape. */
export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

const MAX_LOG_BYTES = 1_000_000;

/** Best-effort, timestamped, never throws. Truncates once the log passes 1 MB. */
export function logErr(message: string): void {
  try {
    const p = paths();
    mkdirSync(p.state, { recursive: true, mode: 0o700 });
    appendFileSync(p.err, `[${new Date().toISOString()}] ${message}\n`);
    if (statSync(p.err).size > MAX_LOG_BYTES) writeFileSync(p.err, "");
  } catch {
    /* best-effort by design */
  }
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
