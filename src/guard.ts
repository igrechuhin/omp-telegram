/**
 * The package's single object guard. Narrowing to `Record<string, unknown>` proves
 * only "is an object"; every caller still checks the fields it reads.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Node fs errors carry a string `code`; this reads it without casting. */
export function errorCode(e: unknown): string | undefined {
  return e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : undefined;
}
