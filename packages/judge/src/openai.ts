import { isIP } from "node:net";
import { z } from "zod";
import { Answer, answerSchema, json, replyPrompt, SYSTEM_PROMPT } from "./questions.ts";
import { OpenAIUsage } from "./response.ts";
import { failureOf, JudgeFailed, reasonForStatus, type FailureReason } from "./failure.ts";
import type { Exchange, Judge, Judgment } from "./verdict.ts";

const WORKERS = 4;
const TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 1024 * 1024;

export type OpenAIOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export class OpenAIFailed extends JudgeFailed {
  constructor(reason: FailureReason, status?: number) {
    super("openai", reason, status === undefined ? null : `HTTP ${status}`);
  }
}

const Completion = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable(),
          refusal: z.string().nullable().optional(),
        }),
        finish_reason: z.string().optional(),
      }),
    )
    .length(1),
  usage: OpenAIUsage,
});

export const keyProblem = (key: string): string | null =>
  /^[\x21-\x7e]+$/.test(key) ? null : "the API key has characters a header cannot carry";

export function endpointProblem(baseUrl: string): string | null {
  if (!URL.canParse(baseUrl)) return "the base URL is not a URL";
  const url = new URL(baseUrl);
  if (url.username || url.password) return "the base URL must not carry a user or password";
  if (url.protocol === "https:") return null;
  if (url.protocol !== "http:") return "the base URL must use https, or http on a local address";
  return local(url.hostname)
    ? null
    : "plain HTTP is only allowed to loopback or private addresses; use https";
}

export class OpenAIJudge implements Judge {
  readonly id: string;
  readonly label: string;
  readonly tokens = { input: 0, output: 0 };
  readonly #url: string;
  readonly #options: OpenAIOptions;
  #broken: OpenAIFailed | null = null;

  constructor(options: OpenAIOptions) {
    const problem = endpointProblem(options.baseUrl);
    if (problem) throw new Error(problem);
    this.#url = completionsUrl(options.baseUrl);
    this.#options = options;
    this.id = OpenAIJudge.idFor(options);
    this.label = `${new URL(this.#url).host} ${options.model}`;
  }

  static idFor({ baseUrl, model }: { baseUrl: string; model: string }): string {
    const base = completionsUrl(baseUrl).replace(/\/chat\/completions$/, "");
    return `openai/reply-v1/${JSON.stringify({ baseUrl: base, model })}`;
  }

  async classify(exchanges: readonly Exchange[]): Promise<Judgment[]> {
    const out: Judgment[] = [];
    let next = 0;
    const worker = async () => {
      while (next < exchanges.length) {
        const i = next++;
        out[i] = await this.#one(exchanges[i] as Exchange);
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, exchanges.length) }, worker));
    return out;
  }

  async #one(exchange: Exchange): Promise<Judgment> {
    if (this.#broken) return this.#broken;
    const { apiKey, model, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS } = this.#options;
    const badKey = apiKey === undefined ? null : keyProblem(apiKey);
    if (badKey) return (this.#broken = new OpenAIFailed("auth"));
    let body: string;
    try {
      const response = await fetch(this.#url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: replyPrompt(exchange) },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "verdict", strict: true, schema: answerSchema },
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const { status } = response;
      if (status < 200 || status > 299) {
        await response.body?.cancel().catch(() => undefined);
        const failure = new OpenAIFailed(
          status >= 300 && status <= 399 ? "bad-request" : reasonForStatus(status),
          status,
        );
        if ((status >= 300 && status <= 399) || [401, 403, 404].includes(status))
          this.#broken = failure;
        return failure;
      }
      const read = await bounded(response);
      if (read === null) return new OpenAIFailed("too-large");
      body = read;
    } catch (error) {
      return new OpenAIFailed(
        failureOf("openai", error).reason === "timeout" ? "timeout" : "server",
      );
    }
    const completion = Completion.safeParse(json(body));
    if (!completion.success) return new OpenAIFailed("malformed");
    this.tokens.input += completion.data.usage?.prompt_tokens ?? 0;
    this.tokens.output += completion.data.usage?.completion_tokens ?? 0;
    const [choice] = completion.data.choices;
    if (choice?.message.refusal || choice?.finish_reason === "content_filter")
      return new OpenAIFailed("refused");
    if (choice?.finish_reason !== "stop") return new OpenAIFailed("malformed");
    const answer = Answer.safeParse(json(choice.message.content ?? ""));
    return answer.success ? answer.data : new OpenAIFailed("malformed");
  }
}

async function bounded(response: Response): Promise<string | null> {
  if (Number(response.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function local(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (isIP(host) === 6) return host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return false;
}

export function completionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path.endsWith("/v1") ? path : `${path}/v1`}/chat/completions`;
  url.search = "";
  url.hash = "";
  return url.href;
}
