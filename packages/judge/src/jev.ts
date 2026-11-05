import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  choice,
  PermissionDeniedError,
  TypeSafeClient,
  type Fetch,
} from "@typesafe-ai/sdk";
import type { CauseInput, CauseJudge } from "./causes.ts";
import { JudgeFailed, reasonForStatus } from "./failure.ts";
import { clipped, KIND_QUESTION, SENDER_QUESTION } from "./questions.ts";
import { jevAnswer } from "./response.ts";
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

export class KeyRejected extends JudgeFailed {
  constructor(readonly httpStatus: number) {
    super("jev", "auth", `HTTP ${httpStatus}`);
  }
}

function jevFailure(error: unknown): JudgeFailed {
  if (error instanceof JudgeFailed) return error;
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError)
    return new KeyRejected(error.status);
  if (error instanceof APITimeoutError) return new JudgeFailed("jev", "timeout");
  if (error instanceof APIConnectionError) return new JudgeFailed("jev", "server");
  if (error instanceof APIError && typeof error.status === "number")
    return new JudgeFailed("jev", reasonForStatus(error.status), `HTTP ${error.status}`);
  return new JudgeFailed("jev", "malformed");
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
      const kindAnswer = jevAnswer(
        await this.#client.systemOne(kind),
        "kind",
        ReplyKind.options,
        MODEL,
      );
      const senderAnswer = jevAnswer(
        await this.#client.systemOne(sender),
        "sender",
        Sender.options,
        MODEL,
      );
      for (const answer of [kindAnswer, senderAnswer]) {
        this.tokens.input += answer.input;
        this.tokens.output += answer.output;
      }
      return {
        kind: ReplyKind.parse(kindAnswer.choice),
        sender: Sender.parse(senderAnswer.choice),
        confidence: kindAnswer.confidence,
      };
    } catch (error) {
      const failure = jevFailure(error);
      if (failure instanceof KeyRejected) throw failure;
      return failure;
    }
  }
}

export const requests = (exchange: Exchange) => {
  const { assistantSaid, reply } = clipped(exchange);
  return {
    kind: {
      state: { assistant_said: assistantSaid, user_reply: reply },
      questions: { kind: choice(KIND_QUESTION, replyKindMeaning) },
    },
    sender: {
      state: { message: reply },
      questions: { sender: choice(SENDER_QUESTION, senderMeaning) },
    },
  };
};

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
    try {
      const result = await this.#client.systemOne(
        {
          state: input.state,
          questions: { theme: choice(input.question, input.choices) },
        },
        { signal: this.#signal },
      );
      const answer = jevAnswer(result, "theme", Object.keys(input.choices), MODEL);
      this.tokens.input += answer.input;
      this.tokens.output += answer.output;
      return { choice: answer.choice, model: answer.model };
    } catch (error) {
      throw jevFailure(error);
    }
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
      const answer = jevAnswer(result, "cause", Object.keys(input.choices), MODEL);
      this.tokens.input += answer.input;
      this.tokens.output += answer.output;
      return { choice: answer.choice, model: answer.model };
    } catch (error) {
      throw jevFailure(error);
    }
  }
}

const withStreamedBody =
  (fetch: Fetch): Fetch =>
  async (input, init) => {
    const response = await fetch(input, init);
    return new Response(response.body?.pipeThrough(new TransformStream()), response);
  };

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
