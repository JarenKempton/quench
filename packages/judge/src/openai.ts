import { z } from "zod";
import { Answer, answerSchema, json, replyPrompt, SYSTEM_PROMPT } from "./questions.ts";
import type { Exchange, Judge, Judgment } from "./verdict.ts";

const WORKERS = 4;
const TIMEOUT_MS = 60_000;

export type OpenAIOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export class OpenAIFailed extends Error {
  constructor(
    readonly reason: "request" | "status" | "unparseable",
    detail: string,
  ) {
    super(`OpenAI-compatible judge ${reason}: ${detail}`);
  }
}

const Completion = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1)
    .max(1),
  usage: z
    .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
    .optional(),
});

export class OpenAIJudge implements Judge {
  readonly id: string;
  readonly label: string;
  readonly tokens = { input: 0, output: 0 };
  readonly #url: string;
  readonly #options: OpenAIOptions;
  #broken: OpenAIFailed | null = null;

  constructor(options: OpenAIOptions) {
    this.#url = completionsUrl(options.baseUrl);
    this.#options = options;
    this.id = OpenAIJudge.idFor(options);
    this.label = `${new URL(this.#url).host} ${options.model}`;
  }

  static idFor({ baseUrl, model }: { baseUrl: string; model: string }): string {
    return `openai/${new URL(completionsUrl(baseUrl)).host}/${model}/reply-v1`;
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
    let response: Response;
    try {
      response = await fetch(this.#url, {
        method: "POST",
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
    } catch (error) {
      return new OpenAIFailed("request", error instanceof Error ? error.message : String(error));
    }
    const body = await response.text().catch(() => "");
    if (!response.ok) {
      const failure = new OpenAIFailed("status", `HTTP ${response.status}`);
      if (response.status === 401 || response.status === 403 || response.status === 404)
        this.#broken = failure;
      return failure;
    }
    const completion = Completion.safeParse(json(body));
    if (!completion.success) return new OpenAIFailed("unparseable", "no single chat completion");
    this.tokens.input += completion.data.usage?.prompt_tokens ?? 0;
    this.tokens.output += completion.data.usage?.completion_tokens ?? 0;
    const answer = Answer.safeParse(json(completion.data.choices[0]?.message.content ?? ""));
    return answer.success
      ? answer.data
      : new OpenAIFailed("unparseable", "the answer was not exactly a verdict");
  }
}

export function completionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path.endsWith("/v1") ? path : `${path}/v1`}/chat/completions`;
  url.search = "";
  url.hash = "";
  return url.href;
}
