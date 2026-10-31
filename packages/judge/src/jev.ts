import {
  AuthenticationError,
  choice,
  PermissionDeniedError,
  TypeSafeClient,
  type Fetch,
  type Usage,
} from "@typesafe-ai/sdk";
import type { CauseInput, CauseJudge } from "./causes.ts";
import type { ThemeInput, ThemeDecision, ThemeJudge } from "./themes.ts";
import {
  ReplyKind,
  replyKindMeaning,
  Sender,
  senderMeaning,
  type Exchange,
  type Judge,
  type Judgment,
} from "./verdict.ts";

const MODEL = "jev-latest";
const WORKERS = 12;
const ASSISTANT_CHARS = 1500;
const REPLY_CHARS = 2000;

export class KeyRejected extends Error {
  constructor(
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(`TypeSafe rejected the API key (HTTP ${status})`, options);
  }
}

export class Jev implements Judge {
  static readonly id = `jev/${MODEL}/reply-v5`;
  readonly id = Jev.id;
  readonly tokens = { input: 0, output: 0 };
  readonly #client: TypeSafeClient;

  constructor(apiKey: string, fetch: Fetch = globalThis.fetch) {
    this.#client = new TypeSafeClient({
      apiKey,
      fetch: withStreamedBody(fetch),
      defaultModel: MODEL,
      logLevel: "off",
    });
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): Jev | null {
    const key = env.TYPESAFE_API_KEY?.trim();
    return key ? new Jev(key) : null;
  }

  classify(exchanges: readonly Exchange[]): Promise<Judgment[]> {
    return mapLimit(exchanges, WORKERS, (e) => this.#one(e));
  }

  async #one(exchange: Exchange): Promise<Judgment> {
    try {
      const { kind, sender } = requests(exchange);
      const kindResult = await this.#client.systemOne(kind);
      const senderResult = await this.#client.systemOne(sender);
      this.#count(kindResult.usage);
      this.#count(senderResult.usage);
      return {
        kind: ReplyKind.parse(kindResult.answers.kind.choice),
        sender: Sender.parse(senderResult.answers.sender.choice),
        confidence: kindResult.answers.kind.confidence,
      };
    } catch (error) {
      if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
        throw new KeyRejected(error.status, { cause: error });
      }
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  #count(usage: Usage): void {
    this.tokens.input += usage.input_tokens ?? 0;
    this.tokens.output += usage.output_tokens ?? 0;
  }
}

export const requests = (exchange: Exchange) => ({
  kind: {
    state: {
      assistant_said: tail(exchange.assistantSaid, ASSISTANT_CHARS),
      user_reply: head(exchange.reply, REPLY_CHARS),
    },
    questions: { kind: choice("What is the user's reply mainly doing?", replyKindMeaning) },
  },
  sender: {
    state: { message: head(exchange.reply, REPLY_CHARS) },
    questions: { sender: choice("Who wrote this message?", senderMeaning) },
  },
});

export class JevThemes implements ThemeJudge {
  static readonly id = `jev/${MODEL}/themes-v1`;
  readonly id = JevThemes.id;
  readonly tokens = { input: 0, output: 0 };
  readonly #client: TypeSafeClient;
  readonly #signal = AbortSignal.timeout(60_000);

  constructor(apiKey: string, fetch: Fetch = globalThis.fetch) {
    this.#client = new TypeSafeClient({
      apiKey,
      fetch: withStreamedBody(fetch),
      defaultModel: MODEL,
      logLevel: "off",
      retry: { maxRetries: 0 },
      timeout: 10_000,
    });
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): JevThemes | null {
    const key = env.TYPESAFE_API_KEY?.trim();
    return key ? new JevThemes(key) : null;
  }

  async assign(input: ThemeInput): Promise<ThemeDecision> {
    const result = await this.#client.systemOne(
      {
        state: input.state,
        questions: { theme: choice(input.question, input.choices) },
      },
      { signal: this.#signal },
    );
    this.tokens.input += result.usage.input_tokens ?? 0;
    this.tokens.output += result.usage.output_tokens ?? 0;
    return { choice: result.answers.theme.choice, model: result.model };
  }
}

export class JevCauses implements CauseJudge {
  static readonly id = `jev/${MODEL}/causes-v1`;
  readonly id = JevCauses.id;
  readonly tokens = { input: 0, output: 0 };
  readonly #client: TypeSafeClient;

  constructor(apiKey: string, fetch: Fetch = globalThis.fetch) {
    this.#client = new TypeSafeClient({
      apiKey,
      fetch: withStreamedBody(fetch),
      defaultModel: MODEL,
      logLevel: "off",
      retry: { maxRetries: 0 },
      timeout: 10_000,
    });
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): JevCauses | null {
    const key = env.TYPESAFE_API_KEY?.trim();
    return key ? new JevCauses(key) : null;
  }

  async cause(input: CauseInput): Promise<ThemeDecision> {
    try {
      const result = await this.#client.systemOne({
        state: input.state,
        questions: { cause: choice(input.question, input.choices) },
      });
      this.tokens.input += result.usage.input_tokens ?? 0;
      this.tokens.output += result.usage.output_tokens ?? 0;
      return { choice: result.answers.cause.choice, model: result.model };
    } catch (error) {
      if (error instanceof AuthenticationError || error instanceof PermissionDeniedError)
        throw new KeyRejected(error.status, { cause: error });
      throw error;
    }
  }
}

const withStreamedBody =
  (fetch: Fetch): Fetch =>
  async (input, init) => {
    const response = await fetch(input, init);
    return new Response(response.body?.pipeThrough(new TransformStream()), response);
  };

const head = (text: string, chars: number) => Array.from(text).slice(0, chars).join("");
const tail = (text: string, chars: number) => Array.from(text).slice(-chars).join("");

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i] as T);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
