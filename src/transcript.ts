import { isRecord } from "./guard";

/**
 * Reads the transcript tail via `ctx.sessionManager.getBranch()`.
 * `type: "message"` entries carry an AgentMessage whose `role` is camelCase;
 * assistant prose lives in `text` content blocks, tool calls in `toolCall` blocks.
 */

export type StopKind = "done" | "error" | "aborted" | "truncated" | "unknown";

export interface LastResponse {
  text: string;
  kind: StopKind;
  errorMessage?: string;
}

export const STATUS_GLYPH: Record<StopKind, string> = {
  done: "🟢",
  error: "🔴",
  aborted: "⏹",
  truncated: "🟠",
  unknown: "⚪️",
};

export const STATUS_LABEL: Record<StopKind, string> = {
  done: "Done",
  error: "Failed",
  aborted: "Stopped",
  truncated: "Truncated",
  unknown: "Idle",
};

export function classifyStop(stopReason: unknown): StopKind {
  switch (stopReason) {
    case undefined:
    case "stop":
    case "toolUse":
      return "done";
    case "error":
      return "error";
    case "aborted":
      return "aborted";
    case "length":
      return "truncated";
    default:
      return "unknown";
  }
}

function messageOf(entry: unknown, role: string): Record<string, unknown> | undefined {
  if (!isRecord(entry) || entry.type !== "message") return undefined;
  const message = entry.message;
  return isRecord(message) && message.role === role ? message : undefined;
}

/** Most recent assistant message; its stop reason decides the status glyph. */
export function lastAssistant(entries: unknown[]): LastResponse {
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = messageOf(entries[i], "assistant");
    if (!message) continue;
    const parts: string[] = [];
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          parts.push(block.text);
        }
      }
    }
    return {
      text: parts.join("\n").trim(),
      kind: classifyStop(message.stopReason),
      errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
    };
  }
  return { text: "", kind: "unknown" };
}

/** Wall-clock start of the current turn, for the elapsed-time line. */
export function turnStartedAt(entries: unknown[]): number | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const message = messageOf(entry, "user");
    if (!message) continue;
    if (typeof message.timestamp === "number") return message.timestamp;
    const raw = isRecord(entry) ? entry.timestamp : undefined;
    const parsed = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
