import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ensureDirs, errMessage, logErr, paths, readJson, stateFile, writeJsonAtomic } from "./config";
import { errorCode, isRecord } from "./guard";
import { type Question, asQuestions } from "./types";

/**
 * File-backed state shared by every omp process on one machine. One process (the
 * leader) owns the Telegram `getUpdates` stream; all processes read their own inbox.
 */

/** A leader that has not heartbeated for this long is presumed dead. */
export const LEADER_STALE_MS = 20_000;
/** A just-created leader file may be empty for a moment; don't steal it. */
const FRESH_FILE_MS = 3_000;
const ROUTING_MAX_AGE_MS = 14 * 24 * 3600_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errorCode(e) === "EPERM";
  }
}

// ---------------------------------------------------------------- leader

export interface LeaderRecord {
  sessionId: string;
  pid: number;
  ts: number;
}

export function readLeader(): LeaderRecord | undefined {
  const raw = readJson(paths().leader);
  if (!isRecord(raw)) return undefined;
  const { sessionId, pid, ts } = raw;
  if (typeof sessionId !== "string" || typeof pid !== "number" || typeof ts !== "number") {
    return undefined;
  }
  return { sessionId, pid, ts };
}

function leaderFileIsFresh(): boolean {
  try {
    return Date.now() - statSync(paths().leader).mtimeMs < FRESH_FILE_MS;
  } catch {
    return false;
  }
}

/**
 * Exclusive-create claim. A stale or dead holder is removed and the claim retried
 * once; two racing stealers are resolved by `heartbeat`, which steps down any
 * process that no longer sees its own id in the file.
 */
export function tryAcquireLeader(sessionId: string): boolean {
  ensureDirs();
  const file = paths().leader;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ sessionId, pid: process.pid, ts: Date.now() }));
      closeSync(fd);
      return true;
    } catch (e) {
      if (errorCode(e) !== "EEXIST") {
        logErr(`leader claim: ${errMessage(e)}`);
        return false;
      }
    }
    const current = readLeader();
    if (current?.sessionId === sessionId && current.pid === process.pid) return true;
    if (current && Date.now() - current.ts < LEADER_STALE_MS && pidAlive(current.pid)) return false;
    if (!current && leaderFileIsFresh()) return false;
    rmSync(file, { force: true });
  }
  return false;
}

/** Refreshes the claim; returns false when another process now owns it. */
export function heartbeat(sessionId: string): boolean {
  const current = readLeader();
  if (current?.sessionId !== sessionId || current.pid !== process.pid) return false;
  writeJsonAtomic(paths().leader, { sessionId, pid: process.pid, ts: Date.now() });
  return true;
}

export function releaseLeader(sessionId: string): void {
  const current = readLeader();
  if (current?.sessionId === sessionId && current.pid === process.pid) {
    rmSync(paths().leader, { force: true });
  }
}

// ---------------------------------------------------------------- offset / away

export function readOffset(): number | undefined {
  const raw = readJson(paths().offset);
  return isRecord(raw) && typeof raw.offset === "number" ? raw.offset : undefined;
}

export function writeOffset(offset: number): void {
  writeJsonAtomic(paths().offset, { offset });
}

export function readAway(): boolean {
  const raw = readJson(paths().away);
  return isRecord(raw) && raw.away === true;
}

export function writeAway(away: boolean): void {
  ensureDirs();
  writeJsonAtomic(paths().away, { away, ts: Date.now() });
}

// ---------------------------------------------------------------- sessions

export interface SessionRecord {
  sessionId: string;
  pid: number;
  cwd: string;
  repo?: string;
  title?: string;
  ts: number;
}

export function registerSession(rec: SessionRecord): void {
  ensureDirs();
  writeJsonAtomic(stateFile.session(rec.sessionId), rec);
}

export function unregisterSession(sessionId: string): void {
  rmSync(stateFile.session(sessionId), { force: true });
}

function parseSession(raw: unknown): SessionRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const { sessionId, pid, cwd, ts } = raw;
  if (typeof sessionId !== "string" || typeof pid !== "number" || typeof cwd !== "string") {
    return undefined;
  }
  return {
    sessionId,
    pid,
    cwd,
    repo: typeof raw.repo === "string" ? raw.repo : undefined,
    title: typeof raw.title === "string" ? raw.title : undefined,
    ts: typeof ts === "number" ? ts : 0,
  };
}

/** A session is live while its file exists and its process runs. */
export function liveSession(sessionId: string): SessionRecord | undefined {
  const rec = parseSession(readJson(stateFile.session(sessionId)));
  return rec && pidAlive(rec.pid) ? rec : undefined;
}

/** Live sessions, newest first; files left by crashed processes are removed. */
export function listSessions(): SessionRecord[] {
  const dir = paths().sessions;
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const live: SessionRecord[] = [];
  for (const name of names) {
    const rec = parseSession(readJson(join(dir, name)));
    if (rec && pidAlive(rec.pid)) live.push(rec);
    else rmSync(join(dir, name), { force: true });
  }
  return live.sort((a, b) => b.ts - a.ts);
}

// ---------------------------------------------------------------- routing

/** Which session a bot message belongs to, keyed by Telegram message_id. */
export interface RoutingRecord {
  messageId: number;
  sessionId: string;
  askId?: string;
  ts: number;
}

export function recordRouting(rec: RoutingRecord): void {
  ensureDirs();
  writeJsonAtomic(stateFile.routing(rec.messageId), rec);
}

function parseRouting(raw: unknown): RoutingRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const { messageId, sessionId, ts } = raw;
  if (typeof messageId !== "number" || typeof sessionId !== "string") return undefined;
  return {
    messageId,
    sessionId,
    askId: typeof raw.askId === "string" ? raw.askId : undefined,
    ts: typeof ts === "number" ? ts : 0,
  };
}

export function resolveRouting(messageId: number): RoutingRecord | undefined {
  return parseRouting(readJson(stateFile.routing(messageId)));
}

export function pruneRouting(now = Date.now()): void {
  let names: string[] = [];
  try {
    names = readdirSync(paths().routing);
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(paths().routing, name);
    try {
      if (now - statSync(file).mtimeMs > ROUTING_MAX_AGE_MS) rmSync(file, { force: true });
    } catch {
      /* raced with another pruner */
    }
  }
}

// ---------------------------------------------------------------- inbox

export interface InboxItem {
  updateId: number;
  text: string;
  fromId: number;
  askId?: string;
  ts: number;
}

/** Leader side. Must succeed before the Telegram offset advances. */
export function appendInbox(sessionId: string, item: InboxItem): void {
  ensureDirs();
  appendFileSync(stateFile.inbox(sessionId), `${JSON.stringify(item)}\n`, { mode: 0o600 });
}

interface Cursor {
  bytes: number;
  lastUpdateId: number;
}

function readCursor(sessionId: string): Cursor {
  const raw = readJson(stateFile.cursor(sessionId));
  if (isRecord(raw) && typeof raw.bytes === "number" && typeof raw.lastUpdateId === "number") {
    return { bytes: raw.bytes, lastUpdateId: raw.lastUpdateId };
  }
  return { bytes: 0, lastUpdateId: -1 };
}

/**
 * Consumer side. Returns complete lines past the cursor; `commit` persists the cursor
 * after delivery. Items are deduped by update id, so a leader crash between inbox
 * append and offset write (Telegram redelivers) never injects a reply twice.
 */
export function readInbox(sessionId: string): { items: InboxItem[]; commit(): void } {
  const cursor = readCursor(sessionId);
  let buf: Buffer;
  try {
    buf = readFileSync(stateFile.inbox(sessionId));
  } catch {
    return { items: [], commit() {} };
  }
  if (buf.length < cursor.bytes) cursor.bytes = 0;
  const end = buf.lastIndexOf(0x0a);
  if (end < cursor.bytes) return { items: [], commit() {} };
  const chunk = buf.subarray(cursor.bytes, end + 1).toString("utf8");
  const items: InboxItem[] = [];
  let last = cursor.lastUpdateId;
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    try {
      const raw: unknown = JSON.parse(line);
      if (!isRecord(raw) || typeof raw.updateId !== "number" || typeof raw.text !== "string") continue;
      if (raw.updateId <= last) continue;
      last = raw.updateId;
      items.push({
        updateId: raw.updateId,
        text: raw.text,
        fromId: typeof raw.fromId === "number" ? raw.fromId : 0,
        askId: typeof raw.askId === "string" ? raw.askId : undefined,
        ts: typeof raw.ts === "number" ? raw.ts : 0,
      });
    } catch {
      /* torn line cannot occur past the last newline; skip garbage */
    }
  }
  const next: Cursor = { bytes: end + 1, lastUpdateId: last };
  return { items, commit: () => writeJsonAtomic(stateFile.cursor(sessionId), next) };
}

export function dropInbox(sessionId: string): void {
  rmSync(stateFile.inbox(sessionId), { force: true });
  rmSync(stateFile.cursor(sessionId), { force: true });
}

// ---------------------------------------------------------------- asks

/** An `ask` call relayed to Telegram, answered one question at a time. */
export interface AskRecord {
  askId: string;
  sessionId: string;
  questions: Question[];
  index: number;
  answers: string[];
  /** Multi-select toggles for the current question. */
  selected: number[];
  messageId?: number;
  done: boolean;
  ts: number;
}

export function saveAsk(rec: AskRecord): void {
  ensureDirs();
  writeJsonAtomic(stateFile.ask(rec.askId), rec);
}

export function loadAsk(askId: string): AskRecord | undefined {
  const raw = readJson(stateFile.ask(askId));
  if (!isRecord(raw) || typeof raw.askId !== "string" || typeof raw.sessionId !== "string") {
    return undefined;
  }
  const questions = asQuestions(raw);
  if (!questions.length || typeof raw.index !== "number") return undefined;
  return {
    askId: raw.askId,
    sessionId: raw.sessionId,
    questions,
    index: raw.index,
    answers: Array.isArray(raw.answers) ? raw.answers.filter((a) => typeof a === "string") : [],
    selected: Array.isArray(raw.selected) ? raw.selected.filter((n) => typeof n === "number") : [],
    messageId: typeof raw.messageId === "number" ? raw.messageId : undefined,
    done: raw.done === true,
    ts: typeof raw.ts === "number" ? raw.ts : 0,
  };
}
