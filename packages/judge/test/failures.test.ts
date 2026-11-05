import { afterAll, expect, test } from "bun:test";
import {
  CANNED_EXCHANGE,
  HarnessJudge,
  Jev,
  JevCauses,
  JevThemes,
  JudgeFailed,
  OpenAIJudge,
} from "../src/index.ts";
import { fakeHarnessPath } from "./fake-path.ts";

const key = 'sk-CANARY"ROUND3-7f3a';
const echoes = [
  JSON.stringify(key),
  JSON.stringify({ error: { message: `invalid key ${JSON.stringify(key)}` } }),
  encodeURIComponent(key),
  `key=${encodeURIComponent(key)}&reason=bad`,
];
const leaks = (text: string) => /CANARY|ROUND3/.test(text);
const FIXED =
  /^(jev|claude|openai) judge failed: (auth|rate-limit|bad-request|server|timeout|too-large|refused|malformed)( \((HTTP|exit) \d+\))?$/;

const expectFixed = (error: unknown) => {
  expect(error).toBeInstanceOf(JudgeFailed);
  const failure = error as Error;
  expect(failure.message).toMatch(FIXED);
  expect(failure.cause).toBeUndefined();
  expect(leaks(`${failure.message}\n${failure.stack}`)).toBe(false);
  expect(leaks(JSON.stringify(failure))).toBe(false);
};

let echo = echoes[0] as string;
let status = 400;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (): Response => new Response(echo, { status }),
});
afterAll(() => server.stop(true));

const fakeFetch = (async () => new Response(echo, { status })) as unknown as typeof fetch;

test("openai errors carry no provider text, whatever the status or body", async () => {
  for (const body of echoes)
    for (const code of [200, 400, 401, 429, 500, 503]) {
      echo = body;
      status = code;
      const judge = new OpenAIJudge({
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        model: "m",
        apiKey: key,
      });
      const [result] = await judge.classify([CANNED_EXCHANGE]);
      expectFixed(result);
    }
});

test("an openai request error that echoes an encoded key carries none of it", async () => {
  for (const body of echoes) {
    const fetch = (async () => {
      throw new Error(`connect failed for ${body}`);
    }) as unknown as typeof globalThis.fetch;
    const judge = new OpenAIJudge({ baseUrl: "https://h/v1", model: "m", apiKey: key, fetch });
    const [result] = await judge.classify([CANNED_EXCHANGE]);
    expectFixed(result);
    expect((result as Error).message).toBe("openai judge failed: server");
  }
});

test("Jev reply, theme and cause errors carry no provider text", async () => {
  for (const body of echoes)
    for (const code of [200, 400, 401, 422]) {
      echo = body;
      status = code;
      const failure = await new Jev(key, fakeFetch)
        .classify([CANNED_EXCHANGE])
        .then(([result]) => result)
        .catch((error: unknown) => error);
      expectFixed(failure);
      const theme = await new JevThemes(key, fakeFetch)
        .assign({ state: { a: "b" }, question: "q", choices: { new: "n", unclear: "u" } } as never)
        .catch((error: unknown) => error);
      expectFixed(theme);
      const cause = await new JevCauses(key, fakeFetch)
        .cause({ state: { a: "b" }, question: "q", choices: { other: "o" } } as never)
        .catch((error: unknown) => error);
      expectFixed(cause);
    }
});

test.skipIf(process.platform === "win32")(
  "claude failures never repeat what claude printed",
  async () => {
    for (const body of echoes) {
      const fake = await fakeHarnessPath({ mode: "exit", stderr: `${body}\n` });
      const judge = await HarnessJudge.create({ PATH: fake.PATH }, 5_000);
      const [result] = await judge.classify([CANNED_EXCHANGE]);
      expectFixed(result);
    }
    const prose = await fakeHarnessPath({ answer: `I think ${echoes[1]}` });
    const judge = await HarnessJudge.create({ PATH: prose.PATH }, 5_000);
    expectFixed((await judge.classify([CANNED_EXCHANGE]))[0]);
  },
);
