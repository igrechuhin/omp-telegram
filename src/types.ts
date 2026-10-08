import { isRecord } from "./guard";

/**
 * Minimal structural view of the omp extension API.
 *
 * Declared locally instead of importing `@oh-my-pi/pi-coding-agent`: that package is
 * not a dependency here, and a shipped omp is a compiled binary, so a real import
 * would only resolve inside a checkout. Types are erased by the host's TS loader.
 */

export interface HookCtx {
  cwd: string;
  mode?: string;
  hasUI?: boolean;
  agent?: { kind: "main" | "sub"; id?: string; name?: string };
  sessionManager?: { getBranch?(): unknown[]; getSessionId?(): string };
  ui?: { notify?(message: string, level?: string): void };
  setInterval?(fn: () => unknown, ms: number): unknown;
  setTimeout?(fn: () => unknown, ms: number): unknown;
  clearTimer?(timer: unknown): void;
  isIdle?(): boolean;
  shutdown?(): unknown;
}

/** Minimal view of the omptype/zod schema builder exposed as `pi.zod`. */
export interface SchemaLike {
  optional(): SchemaLike;
  describe(text: string): SchemaLike;
}

export interface ZodLike {
  object(shape: Record<string, SchemaLike>): SchemaLike;
  array(item: SchemaLike): SchemaLike;
  string(): SchemaLike;
  number(): SchemaLike;
  boolean(): SchemaLike;
}

/** One block of an `AgentToolResult`. Only the text shape is produced here. */
export interface ToolResultBlock {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolResultBlock[];
  details?: unknown;
  isError?: boolean;
}

/**
 * `ctx` passed to a registered tool's `execute`. `invokeTool` runs the *native*
 * built-in that this tool shadows, and is absent when no built-in of that name
 * exists — `ask.enabled: false`, or a session with no prompt surface.
 */
export interface ToolCtx {
  invokeTool?(
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal; onUpdate?: (update: unknown) => void },
  ): Promise<ToolResult>;
}

export interface ToolDefinitionLike {
  name: string;
  label?: string;
  description: string;
  parameters: SchemaLike;
  strict?: boolean;
  approval?: "read" | "write" | "exec";
  concurrency?: "exclusive" | "shared";
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: ToolCtx,
  ): Promise<ToolResult>;
}

export interface PiLike {
  on<E = unknown>(event: string, handler: (event: E, ctx: HookCtx) => unknown): void;
  registerCommand(
    name: string,
    opts: { description?: string; handler: (args: string, ctx: HookCtx) => unknown },
  ): void;
  exec(
    command: string,
    args: string[],
    options?: { cwd?: string; signal?: AbortSignal },
  ): Promise<unknown>;
  sendUserMessage(
    content: string,
    options?: { deliverAs?: "steer" | "followUp" | "aside"; attribution?: "user" | "agent" },
  ): unknown;
  getSessionName?(): string | undefined;
  /** Absent on hosts predating extension tool registration. */
  registerTool?(definition: ToolDefinitionLike): unknown;
  /** Schema builder for a registered tool's `parameters`. */
  zod?: ZodLike;
}

/** `pi.exec` resolves to a string or a result object depending on host version. */
export function execStdout(result: unknown): string {
  if (typeof result === "string") return result;
  if (!isRecord(result)) return "";
  for (const key of ["stdout", "output", "text"]) {
    const value = result[key];
    if (typeof value === "string") return value;
  }
  return "";
}

export interface QuestionOption {
  label: string;
  description?: string;
}

/** Shape of one entry in the built-in `ask` tool's `questions` input. */
export interface Question {
  id: string;
  question: string;
  options: QuestionOption[];
  header?: string;
  multi?: boolean;
  recommended?: number;
}

export function asQuestions(input: unknown): Question[] {
  if (!isRecord(input) || !Array.isArray(input.questions)) return [];
  const out: Question[] = [];
  for (const raw of input.questions) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.question !== "string") continue;
    const options: QuestionOption[] = [];
    if (Array.isArray(raw.options)) {
      for (const opt of raw.options) {
        if (!isRecord(opt) || typeof opt.label !== "string") continue;
        options.push({
          label: opt.label,
          description: typeof opt.description === "string" ? opt.description : undefined,
        });
      }
    }
    out.push({
      id: raw.id,
      question: raw.question,
      options,
      header: typeof raw.header === "string" ? raw.header : undefined,
      multi: raw.multi === true,
      recommended: typeof raw.recommended === "number" ? raw.recommended : undefined,
    });
  }
  return out;
}
