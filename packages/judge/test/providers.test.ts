import { afterAll, expect, test } from "bun:test";
import {
  CANNED_EXCHANGE,
  completionsUrl,
  endpointProblem,
  HarnessJudge,
  HarnessUnsupported,
  Jev,
  OpenAIFailed,
  OpenAIJudge,
  provider,
  redact,
  scrub,
  type Exchange,
} from "../src/index.ts";
import { fakeCalls, fakeHarnessPath } from "./fake-path.ts";

type Reply = { status?: number; body: unknown };
const requests: { path: string; auth: string | null; body: Record<string, unknown> }[] = [];
let reply: Reply = { body: {} };
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request): Promise<Response> {
    requests.push({
      path: new URL(request.url).pathname,
      auth: request.headers.get("authorization"),
      body: (await request.json()) as Record<string, unknown>,
    });
    if (new URL(request.url).pathname.startsWith("/bounce"))
      return new Response(null, {
        status: 307,
        headers: { location: `http://127.0.0.1:${server.port}/landed` },
      });
    const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(body, { status: reply.status ?? 200 });
  },
});
afterAll(() => server.stop(true));

const baseUrl = `http://127.0.0.1:${server.port}/v1`;
const idOf = (base: string, model: string) =>
  `openai/reply-v1/${JSON.stringify({ baseUrl: base, model })}`;
const completion = (content: string, extra: object = {}) => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop", ...extra }],
  usage: { prompt_tokens: 11, completion_tokens: 3 },
});
const good = '{"kind":"correction","sender":"person","confidence":0.8}';
const exchange: Exchange = { assistantSaid: `${"x".repeat(3000)}TAIL`, reply: "no, undo that" };

async function judged(answer: Reply, apiKey?: string) {
  reply = answer;
  requests.length = 0;
  const judge = new OpenAIJudge({ baseUrl, model: "small-model", ...(apiKey ? { apiKey } : {}) });
  return { judge, results: await judge.classify([exchange, exchange]) };
}

test("openai sends the shared clipped prompt with a strict JSON schema and reads a verdict", async () => {
  const { judge, results } = await judged({ body: completion(good) }, "sk-test");
  expect(results).toEqual([
    { kind: "correction", sender: "person", confidence: 0.8 },
    { kind: "correction", sender: "person", confidence: 0.8 },
  ]);
  expect(judge.id).toBe(idOf(baseUrl, "small-model"));
  expect(judge.tokens).toEqual({ input: 22, output: 6 });
  const sent = requests[0];
  expect(sent?.path).toBe("/v1/chat/completions");
  expect(sent?.auth).toBe("Bearer sk-test");
  expect(sent?.body.model).toBe("small-model");
  expect(sent?.body.response_format).toMatchObject({
    type: "json_schema",
    json_schema: { strict: true, schema: { additionalProperties: false } },
  });
  const user = JSON.stringify(sent?.body.messages);
  expect(user).toContain("TAIL");
  expect(user).not.toContain("x".repeat(1501));
});

test("openai turns malformed answers into errors, never a guess", async () => {
  for (const body of [
    completion("correction"),
    completion(`\`\`\`json\n${good}\n\`\`\``),
    completion('{"kind":"correction","sender":"person","confidence":0.8,"why":"x"}'),
    completion('{"kind":"rant","sender":"person","confidence":0.8}'),
    completion('{"kind":"correction","sender":"person","confidence":2}'),
    { choices: [] },
    "not json",
  ]) {
    const { results } = await judged({ body });
    for (const result of results) {
      expect(result).toBeInstanceOf(OpenAIFailed);
      expect((result as Error).message).toBe("openai judge failed: malformed");
    }
  }
});

test("openai reports HTTP errors, and stops calling after the key is rejected", async () => {
  const flaky = await judged({ status: 500, body: { error: "boom" } });
  expect(flaky.results.every((r) => r instanceof OpenAIFailed)).toBe(true);
  expect(requests).toHaveLength(2);

  reply = { status: 401, body: { error: "bad key" } };
  requests.length = 0;
  const judge = new OpenAIJudge({ baseUrl, model: "m", apiKey: "wrong" });
  const results = await judge.classify(Array.from({ length: 10 }, () => exchange));
  expect(results.every((r) => r instanceof Error && r.message.includes("HTTP 401"))).toBe(true);
  expect(requests.length).toBeLessThanOrEqual(4);
  expect(requests[0]?.auth).toBe("Bearer wrong");
});

test("openai reports an unreachable endpoint as an error", async () => {
  const judge = new OpenAIJudge({ baseUrl: "http://127.0.0.1:1/v1", model: "m" });
  const [result] = await judge.classify([CANNED_EXCHANGE]);
  expect(result).toBeInstanceOf(OpenAIFailed);
});

test("an OpenAI base URL may name /v1 or not", () => {
  for (const base of ["http://h:1", "http://h:1/", "http://h:1/v1", "http://h:1/v1/"])
    expect(completionsUrl(base)).toBe("http://h:1/v1/chat/completions");
  expect(completionsUrl("https://h/openai/v1")).toBe("https://h/openai/v1/chat/completions");
});

test("the factory builds each provider under its own judge id", async () => {
  const jev = provider({ name: "jev", apiKey: "k" });
  expect([jev.id, jev.callsPerReply]).toEqual([Jev.id, 2]);
  expect(await jev.create()).toBeInstanceOf(Jev);
  expect(await provider({ name: "jev" }).create()).toBeNull();

  const none = provider({ name: "none" });
  expect([none.id, await none.create()]).toEqual([null, null]);

  const openai = provider({ name: "openai", baseUrl, model: "small-model" });
  expect(openai.id).toBe(idOf(baseUrl, "small-model"));
  reply = { body: completion(good) };
  expect(await (await openai.create())?.classify([CANNED_EXCHANGE])).toEqual([
    { kind: "correction", sender: "person", confidence: 0.8 },
  ]);

  const windows = await provider({ name: "claude" }, {}, "win32")
    .create()
    .catch((error: unknown) => error);
  expect(windows).toBeInstanceOf(HarnessUnsupported);
});

test.skipIf(process.platform === "win32")(
  "the claude provider classifies through claude -p on PATH",
  async () => {
    const fake = await fakeHarnessPath({ answer: good });
    const claude = provider({ name: "claude" }, { PATH: fake.PATH });
    expect(claude.id).toBe(HarnessJudge.id);
    expect(await (await claude.create())?.classify([CANNED_EXCHANGE])).toEqual([
      { kind: "correction", sender: "person", confidence: 0.8 },
    ]);
    expect(await fakeCalls(fake)).toHaveLength(1);
  },
);

const CANARY = "CANARY4c1d";

test("a key a header cannot carry is refused before any request, and never printed", async () => {
  requests.length = 0;
  for (const apiKey of [
    `sk-${CANARY}\n`,
    `sk-${CANARY} x`,
    `sk-${CANARY}é`,
    `sk-${CANARY}\u0000`,
  ]) {
    const judge = new OpenAIJudge({ baseUrl, model: "m", apiKey });
    const [result] = await judge.classify([CANNED_EXCHANGE]);
    expect(result).toBeInstanceOf(OpenAIFailed);
    expect(`${(result as Error).message}${(result as Error).stack}`).not.toContain(CANARY);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  }
  expect(requests).toHaveLength(0);
});

test("a request error that echoes the key is redacted", async () => {
  const apiKey = `sk-${CANARY}`;
  const fetch = (async () => {
    throw new Error(`refused Bearer ${apiKey}`);
  }) as unknown as typeof globalThis.fetch;
  const [result] = await new OpenAIJudge({ baseUrl, model: "m", apiKey, fetch }).classify([
    CANNED_EXCHANGE,
  ]);
  expect(`${(result as Error).message}${(result as Error).stack}`).not.toContain(CANARY);
});

test("plain HTTP is only for loopback and private addresses", () => {
  for (const ok of [
    "http://127.0.0.1:8080/v1",
    "http://localhost:11434",
    "http://10.1.2.3/v1",
    "http://172.16.0.9/v1",
    "http://192.168.1.20/v1",
    "http://[::1]:8080",
    "http://[fd12::1]/v1",
    "https://api.example.com/v1",
  ])
    expect(endpointProblem(ok)).toBeNull();
  for (const bad of [
    "http://api.example.com/v1",
    "http://8.8.8.8/v1",
    "http://172.32.0.1/v1",
    "http://my-box.local/v1",
    "ftp://127.0.0.1/v1",
    "https://user:pass@api.example.com/v1",
    "not a url",
  ])
    expect(endpointProblem(bad)).not.toBeNull();
  expect(() => new OpenAIJudge({ baseUrl: "http://api.example.com/v1", model: "m" })).toThrow(
    "plain HTTP",
  );
});

test("the judge id keeps the whole base URL, so two paths on one host never share a cache", () => {
  const a = OpenAIJudge.idFor({ baseUrl: "https://h/team-a/v1/", model: "m" });
  const b = OpenAIJudge.idFor({ baseUrl: "https://h/team-b", model: "m" });
  expect(a).toBe(idOf("https://h/team-a/v1", "m"));
  expect(b).toBe(idOf("https://h/team-b/v1", "m"));
  expect(OpenAIJudge.idFor({ baseUrl: "https://h/team-a/v1", model: "n" })).not.toBe(a);
});

test("a response over 1 MiB is a failure", async () => {
  const { results } = await judged({ body: completion(good, { pad: "x".repeat(1_100_000) }) });
  for (const result of results)
    expect((result as Error).message).toBe("openai judge failed: too-large");
});

test("a cut-off, filtered or refused answer is a failure, never a verdict", async () => {
  for (const extra of [
    { finish_reason: "length" },
    { finish_reason: "content_filter" },
    { finish_reason: undefined },
    { message: { role: "assistant", content: good, refusal: "I can't help with that" } },
    { message: { role: "assistant", content: null, refusal: "no" } },
  ]) {
    const { results } = await judged({ body: completion(good, extra) });
    for (const result of results) expect(result).toBeInstanceOf(OpenAIFailed);
  }
  const { results } = await judged({
    body: completion(good, { message: { role: "assistant", content: good, refusal: null } }),
  });
  expect(results[0]).toEqual({ kind: "correction", sender: "person", confidence: 0.8 });
});

test("base URL and model pairs that concatenate alike still get different ids", () => {
  const one = OpenAIJudge.idFor({ baseUrl: "https://h/v1", model: "v1/m" });
  const two = OpenAIJudge.idFor({ baseUrl: "https://h/v1/v1", model: "m" });
  expect(one).not.toBe(two);
});

test("a redirect is a failure and is never followed, so the body never leaves the endpoint", async () => {
  requests.length = 0;
  reply = { body: completion(good) };
  const judge = new OpenAIJudge({
    baseUrl: `http://127.0.0.1:${server.port}/bounce/v1`,
    model: "m",
    apiKey: "sk-test",
  });
  const results = await judge.classify([
    exchange,
    exchange,
    exchange,
    exchange,
    exchange,
    exchange,
  ]);
  for (const result of results) {
    expect(result).toBeInstanceOf(OpenAIFailed);
    expect((result as Error).message).toBe("openai judge failed: bad-request (HTTP 307)");
  }
  expect(requests.every((r) => r.path.startsWith("/bounce"))).toBe(true);
  expect(requests.length).toBeLessThanOrEqual(4);
});

test("an oversized 401 still stops the batch", async () => {
  reply = { status: 401, body: { error: "x".repeat(2_000_000) } };
  requests.length = 0;
  const judge = new OpenAIJudge({ baseUrl, model: "m", apiKey: "wrong" });
  const results = await judge.classify(Array.from({ length: 12 }, () => exchange));
  expect(results.every((r) => r instanceof Error && r.message.includes("HTTP 401"))).toBe(true);
  expect(requests.length).toBeLessThanOrEqual(4);
});

test("a malformed Jev key is refused before use, and never printed", async () => {
  const failure = await provider({ name: "jev", apiKey: `sk-${CANARY}\u0007` })
    .create()
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(`${(failure as Error).message}${(failure as Error).stack}`).not.toContain(CANARY);
});

test("one redaction covers messages, stacks and causes", () => {
  const key = `sk-${CANARY}`;
  expect(redact(`bad header ${key} and ${key}`, [key, undefined, ""])).toBe(
    "bad header [key] and [key]",
  );
  const error = scrub(new Error(`outer ${key}`, { cause: new Error(`inner ${key}`) }), [key]);
  expect(`${error.message}${error.stack}${(error.cause as Error).message}`).not.toContain(CANARY);
});

test("the factory scrubs keys from every provider's errors", async () => {
  const apiKey = `sk-${CANARY}`;
  reply = { body: completion(`{"echo":"${apiKey}"}`) };
  const openai = await provider({ name: "openai", baseUrl, model: "m", apiKey }).create();
  const [result] = (await openai?.classify([CANNED_EXCHANGE])) ?? [];
  expect(result).toBeInstanceOf(Error);
  expect(`${(result as Error).message}${(result as Error).stack}`).not.toContain(CANARY);
});
