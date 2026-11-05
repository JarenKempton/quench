import { afterAll, expect, test } from "bun:test";
import {
  CANNED_EXCHANGE,
  HarnessJudge,
  Jev,
  JevCauses,
  JevThemes,
  JudgeFailed,
  OpenAIJudge,
  ThemeDecision,
  Verdict,
} from "../src/index.ts";
import { fakeHarnessPath } from "./fake-path.ts";

const CANARY = "CANARY-R4\u001b[31m";
const leaks = (value: unknown) => JSON.stringify(value).includes("CANARY");

type Answer = { choice?: unknown; confidence?: unknown };
const jevFetch = (answer: (question: string) => Answer, extra: Record<string, unknown> = {}) =>
  (async (_url: unknown, init?: RequestInit) => {
    const question = Object.keys(JSON.parse(init?.body as string).questions)[0] as string;
    return Response.json({
      model: "jev-test",
      answers: { [question]: { type: "choice", probabilities: {}, ...answer(question) } },
      usage: { input_tokens: 10, output_tokens: 2 },
      ...extra,
    });
  }) as unknown as typeof fetch;

const replyAnswer =
  (confidence: unknown) =>
  (question: string): Answer =>
    question === "kind"
      ? { choice: "correction", confidence }
      : { choice: "person", confidence: 1 };

const malformed = (result: unknown) => {
  expect(result).toBeInstanceOf(JudgeFailed);
  expect((result as JudgeFailed).reason).toBe("malformed");
  expect(leaks((result as Error).message)).toBe(false);
};

test("Jev confidence must be a finite number in [0,1] or null before it can become a verdict", async () => {
  for (const confidence of [CANARY, "0.9", 1.5, -0.1, { v: CANARY }]) {
    const [result] = await new Jev("k", jevFetch(replyAnswer(confidence))).classify([
      CANNED_EXCHANGE,
    ]);
    malformed(result);
  }
  for (const confidence of [0, 0.25, 1, null]) {
    const [result] = await new Jev("k", jevFetch(replyAnswer(confidence))).classify([
      CANNED_EXCHANGE,
    ]);
    expect(result).toEqual({ kind: "correction", sender: "person", confidence });
  }
});

test("Jev usage counts must be non-negative safe integers or null", async () => {
  for (const count of [CANARY, "12", -1, 1.5, 2 ** 60]) {
    const judge = new Jev(
      "k",
      jevFetch(replyAnswer(1), { usage: { input_tokens: count, output_tokens: 2 } }),
    );
    malformed((await judge.classify([CANNED_EXCHANGE]))[0]);
    expect(judge.tokens).toEqual({ input: 0, output: 0 });
  }
  const judge = new Jev("k", jevFetch(replyAnswer(1), { usage: { input_tokens: null } }));
  expect((await judge.classify([CANNED_EXCHANGE]))[0]).toMatchObject({ kind: "correction" });
  expect(judge.tokens).toEqual({ input: 0, output: 0 });
});

const themeInput = { state: { a: "b" }, question: "q", choices: { new: "n", unclear: "u" } };
const causeInput = { state: { a: "b" }, question: "q", choices: { other: "o", wrong_file: "w" } };

test("a Jev model label outside the strict charset is replaced by the configured model", async () => {
  for (const model of [CANARY, "", "x".repeat(101), "a b", 42, null]) {
    const themes = new JevThemes(
      "k",
      jevFetch(() => ({ choice: "new", confidence: 1 }), { model }),
    );
    const decision = await themes.assign(themeInput as never);
    expect(decision).toEqual({ choice: "new", model: "jev-latest" });
    const causes = new JevCauses(
      "k",
      jevFetch(() => ({ choice: "other", confidence: 1 }), { model }),
    );
    expect(await causes.cause(causeInput as never)).toEqual({
      choice: "other",
      model: "jev-latest",
    });
  }
  const kept = new JevThemes(
    "k",
    jevFetch(() => ({ choice: "new", confidence: 1 }), { model: "jev-2026.10:small/a_b-c" }),
  );
  expect((await kept.assign(themeInput as never)).model).toBe("jev-2026.10:small/a_b-c");
});

test("theme and cause choices, confidences and usage are checked before they are returned", async () => {
  for (const [answer, extra] of [
    [{ choice: `t9${CANARY}`, confidence: 1 }, {}],
    [{ choice: "new", confidence: CANARY }, {}],
    [{ choice: "new", confidence: 1 }, { usage: { input_tokens: CANARY } }],
  ] as const) {
    const themes = new JevThemes(
      "k",
      jevFetch(() => answer, extra),
    );
    malformed(await themes.assign(themeInput as never).catch((error: unknown) => error));
    expect(themes.tokens).toEqual({ input: 0, output: 0 });
    const causes = new JevCauses(
      "k",
      jevFetch(() => answer, extra),
    );
    malformed(await causes.cause(causeInput as never).catch((error: unknown) => error));
  }
});

test("cached verdicts and theme decisions with provider junk are not accepted", () => {
  const verdict = { kind: "correction", sender: "person" };
  for (const confidence of [CANARY, 2, -1])
    expect(Verdict.safeParse({ ...verdict, confidence }).success).toBe(false);
  expect(Verdict.safeParse({ ...verdict, confidence: null }).success).toBe(true);
  expect(ThemeDecision.safeParse({ choice: "new", model: CANARY }).success).toBe(false);
  expect(ThemeDecision.safeParse({ choice: "new", model: "jev-latest" }).success).toBe(true);
});

const bodies: unknown[] = [];
let completion: unknown = {};
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => {
    bodies.push(completion);
    return Response.json(completion);
  },
});
afterAll(() => server.stop(true));
const good = '{"kind":"correction","sender":"person","confidence":0.5}';

test("openai usage and confidence are checked before anything is counted or returned", async () => {
  for (const usage of [
    { prompt_tokens: CANARY },
    { prompt_tokens: -3 },
    { completion_tokens: 1.5 },
    { prompt_tokens: 2 ** 60 },
  ]) {
    completion = { choices: [{ message: { content: good }, finish_reason: "stop" }], usage };
    const judge = new OpenAIJudge({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "m" });
    malformed((await judge.classify([CANNED_EXCHANGE]))[0]);
    expect(judge.tokens).toEqual({ input: 0, output: 0 });
  }
  for (const confidence of [`"${CANARY}"`, "1.5", "-1"]) {
    completion = {
      choices: [
        {
          message: {
            content: `{"kind":"correction","sender":"person","confidence":${confidence}}`,
          },
          finish_reason: "stop",
        },
      ],
    };
    const judge = new OpenAIJudge({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "m" });
    malformed((await judge.classify([CANNED_EXCHANGE]))[0]);
  }
});

test.skipIf(process.platform === "win32")(
  "claude confidence outside [0,1] or not a number is malformed",
  async () => {
    for (const confidence of [`"${CANARY}"`, "2", "-0.5"]) {
      const fake = await fakeHarnessPath({
        answer: `{"kind":"correction","sender":"person","confidence":${confidence}}`,
      });
      const judge = await HarnessJudge.create({ PATH: fake.PATH }, 5_000);
      malformed((await judge.classify([CANNED_EXCHANGE]))[0]);
    }
  },
);
