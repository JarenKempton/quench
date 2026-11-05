export type FailureReason =
  | "auth"
  | "rate-limit"
  | "bad-request"
  | "server"
  | "timeout"
  | "too-large"
  | "refused"
  | "malformed";

export type ProviderName = "jev" | "claude" | "openai";

export class JudgeFailed extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly reason: FailureReason,
    readonly status: string | null = null,
  ) {
    super(`${provider} judge failed: ${reason}${status === null ? "" : ` (${status})`}`);
  }
}

export function reasonForStatus(status: number): FailureReason {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status === 408) return "timeout";
  if (status === 413) return "too-large";
  if (status >= 500) return "server";
  return "bad-request";
}

export function failureOf(provider: ProviderName, error: unknown): JudgeFailed {
  if (error instanceof JudgeFailed) return error;
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 300)
    return new JudgeFailed(provider, reasonForStatus(status), `HTTP ${status}`);
  const name = error instanceof Error ? error.name : "";
  if (/timeout/i.test(name) || name === "AbortError") return new JudgeFailed(provider, "timeout");
  if (name === "ZodError" || error instanceof SyntaxError)
    return new JudgeFailed(provider, "malformed");
  return new JudgeFailed(provider, "server");
}
