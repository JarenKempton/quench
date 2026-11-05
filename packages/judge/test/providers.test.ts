import { afterAll, expect, test } from "bun:test";
import {
  CANNED_EXCHANGE,
  completionsUrl,
  HarnessJudge,
  HarnessUnsupported,
  Jev,
  OpenAIFailed,
  OpenAIJudge,
  provider,
  type Exchange,
} from "../src/index.ts";
import { fakeCalls, fakeHarnessPath } from "./fake-path.ts";

type Reply = { status?: number; body: unknown };
const requests: { path: string; auth: string | null; body: Record<string, unknown> }[] = [];
let reply: Reply = { body: {} };
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    requests.push({
      path: new URL(request.url).pathname,
      auth: request.headers.get("authorization"),
      body: (await request.json()) as Record<string, unknown>,
    });
    const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(body, { status: reply.status ?? 200 });
  },
});
afterAll(() => server.stop(true));

const baseUrl = `http://127.0.0.1:${server.port}/v1`;
const completion = (content: string) => ({
  choices: [{ message: { role: "assistant", content } }],
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
  expect(judge.id).toBe(`openai/127.0.0.1:${server.port}/small-model/reply-v1`);
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
      expect((result as Error).message).toContain("unparseable");
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
  expect(openai.id).toBe(`openai/127.0.0.1:${server.port}/small-model/reply-v1`);
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
