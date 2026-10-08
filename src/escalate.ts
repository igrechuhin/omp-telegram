import type { ToolCtx, ToolResult } from "./types";

/**
 * Timeout escalation for the `ask` tool.
 *
 * `away` mode decides *before* the question is asked: it blocks the terminal dialog
 * outright. Escalation instead starts the terminal dialog and only moves the question
 * to Telegram once it has gone unanswered for a while, so a question asked while you
 * are at the keyboard behaves exactly as before.
 *
 * This lives in a tool that shadows the built-in `ask` rather than in the `tool_call`
 * hook, because a hook can only block a call — it cannot return a result, and it cannot
 * cancel a dialog the host has already opened. A shadowing tool owns the call: it runs
 * the native dialog through `ctx.invokeTool` with its *own* abort signal, so exactly one
 * of the two channels survives and the loser is destroyed rather than left to answer
 * later. That is what keeps this free of stale-answer bookkeeping.
 */

/** Settled native call, carried as a value so the losing race never rejects unobserved. */
type Outcome = { ok: true; result: ToolResult } | { ok: false; error: unknown };

export interface EscalateDeps {
  /** Milliseconds to wait for a terminal answer before relaying. 0 disables escalation. */
  escalateMs(): number;
  /** Relays the question to Telegram. False keeps it in the terminal instead of losing it. */
  escalate(params: Record<string, unknown>): Promise<boolean>;
}

/** Returned to the model when the question moved to Telegram. A success, not an error. */
export const ESCALATED_TEXT =
  "This question went unanswered in the terminal, so it was sent to the user on Telegram. " +
  "End your turn now without further tool calls and without re-asking. " +
  "Their answer will arrive as the next user message.";

/**
 * Races the native terminal dialog against the escalation timer.
 *
 * Terminal answers first  → its result is returned verbatim; the timer is dropped.
 * Timer fires first       → the dialog is aborted, then the question goes to Telegram.
 *
 * The dialog is aborted *before* relaying so a terminal answer landing in the same
 * instant still wins outright; only a genuinely abandoned dialog is relayed. If the
 * relay then fails, the dialog is reopened without a deadline so the question survives.
 */
export async function askWithEscalation(
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: ((update: unknown) => void) | undefined,
  ctx: ToolCtx,
  deps: EscalateDeps,
): Promise<ToolResult> {
  const native = ctx.invokeTool;
  if (!native) throw new Error("ask is unavailable: this session has no interactive prompt surface");

  const ms = deps.escalateMs();
  if (ms <= 0) return native(params, { signal, onUpdate });

  const local = new AbortController();
  // An already-aborted signal never fires `abort`, so this pre-check is required:
  // without it the dialog would run on a live signal the host already cancelled,
  // and the `await guarded` below could never settle.
  if (signal?.aborted) local.abort(signal.reason);
  const propagate = () => local.abort(signal?.reason);
  signal?.addEventListener("abort", propagate, { once: true });

  try {
    const guarded: Promise<Outcome> = native(params, { signal: local.signal, onUpdate }).then(
      (result): Outcome => ({ ok: true, result }),
      (error): Outcome => ({ ok: false, error }),
    );

    const ESCALATE = Symbol("escalate");
    const deadline = Promise.withResolvers<typeof ESCALATE>();
    const timer = setTimeout(() => deadline.resolve(ESCALATE), ms);

    let settled: Outcome | typeof ESCALATE;
    try {
      settled = await Promise.race([guarded, deadline.promise]);
    } finally {
      clearTimeout(timer);
    }

    // Answered, or cancelled, in time: the terminal owns this call.
    if (settled !== ESCALATE) {
      if (settled.ok) return settled.result;
      throw settled.error;
    }

    // Interrupted rather than unanswered: surface the host's own cancellation.
    if (signal?.aborted) {
      const interrupted = await guarded;
      if (interrupted.ok) return interrupted.result;
      throw interrupted.error;
    }

    local.abort(new Error("ask escalated to Telegram"));
    const raced = await guarded;
    // Answered in the gap between the deadline and the abort landing: terminal still wins.
    if (raced.ok) return raced.result;

    if (await deps.escalate(params)) {
      return { content: [{ type: "text", text: ESCALATED_TEXT }], details: { escalated: true } };
    }

    // Telegram was unreachable. Reopen the dialog, this time without a deadline, so the
    // question is never silently dropped.
    return native(params, { signal, onUpdate });
  } finally {
    signal?.removeEventListener("abort", propagate);
  }
}
