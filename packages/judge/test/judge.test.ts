import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runs } from "@quench/insights";
import {
  Jev,
  KeyRejected,
  VerdictCache,
  judgeReplies,
  summarize,
  type Exchange,
  type Verdict,
} from "../src/index.ts";
import { requests } from "../src/jev.ts";

const exchange = (reply: string): Exchange => ({ assistantSaid: "done", reply });
const verdict: Verdict = { kind: "correction", sender: "person", confidence: 1 };
const cachePath = async () =>
  join(await mkdtemp(join(tmpdir(), "quench-judge-")), "judgments.jsonl");

test("each exchange is remembered across opens, and a new judge id starts clean", async () => {
  const path = await cachePath();
  const first = await VerdictCache.open(path, "judge/v1");
  await first.remember([[exchange("no, wrong file"), verdict]]);

  const reopened = await VerdictCache.open(path, "judge/v1");
  expect(reopened.get(exchange("no, wrong file"))).toEqual(verdict);
  expect(reopened.get(exchange("great"))).toBeUndefined();

  const changed = await VerdictCache.open(path, "judge/v2");
  expect(changed.size).toBe(0);
  expect(await Bun.file(path).text()).toBe("");
});

test("generic sender evidence overrides cached guesses without changing verdicts or run boundaries", async () => {
  const cache = await VerdictCache.open(await cachePath(), "judge/v1");
  await cache.remember([[exchange("no"), verdict]]);
  const list = runs({
    id: "s",
    harness: "codex",
    path: "/unused",
    cwd: null,
    parent: null,
    diagnostics: { lines: 4, unparsed: 0 },
    events: [
      { type: "message", author: "user", origin: "host", text: "build", at: null },
      {
        type: "inference",
        model: null,
        effort: null,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        at: null,
      },
      { type: "message", author: "assistant", origin: "unknown", text: "done", at: null },
      {
        type: "message",
        author: "user",
        origin: "host",
        text: "no",
        at: null,
        sender: { sender: "automation", source: "another-host", messageId: "m" },
      },
    ],
  });
  const run = list[0]!;
  const judged = await judgeReplies(
    [
      {
        harness: "codex",
        cwd: null,
        runs: [
          run,
          { ...run, replyOrigin: "typed" },
          { ...run, replyOrigin: "scheduled" },
          { ...run, replySender: null },
        ],
      },
    ],
    cache,
    null,
  );
  expect(list).toHaveLength(1);
  expect(judged.replies.map((r) => [r.sender, r.senderSource])).toEqual([
    ["automation", "host"],
    ["person", "harness"],
    ["automation", "harness"],
    ["person", "judge"],
  ]);
  expect([judged.newlyJudged, judged.pending, cache.size]).toEqual([0, 0, 1]);
  expect(cache.get(exchange("no"))).toEqual(verdict);
  expect(summarize(judged.replies, 10).senderSources).toEqual({
    harness: 2,
    host: 1,
    judge: 1,
    unknown: 0,
  });
});

test("the sender question never sees the agent message", () => {
  const { kind, sender } = requests({
    assistantSaid: "x".repeat(5000),
    reply: "no, the other file",
  });
  expect(kind.state.assistant_said).toHaveLength(1500);
  expect(Object.keys(kind.questions.kind.criteria)).toHaveLength(5);
  expect(sender.state).toEqual({ message: "no, the other file" });
});

const answering =
  (status: number, answers: (question: string) => unknown) =>
  async (_input: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as { questions: Record<string, unknown> };
    const question = Object.keys(body.questions)[0] ?? "";
    return Response.json(
      {
        model: "jev-test",
        answers: { [question]: answers(question) },
        usage: { input_tokens: 10, output_tokens: 2 },
      },
      { status },
    );
  };

test("Jev reads both answers, counts tokens, and fails one reply on an unknown label", async () => {
  const jev = new Jev(
    "key",
    answering(200, (q) =>
      q === "kind"
        ? { type: "choice", choice: "correction", confidence: 0.9, probabilities: {} }
        : { type: "choice", choice: "automation", confidence: 1, probabilities: {} },
    ),
  );
  expect(await jev.classify([exchange("no")])).toEqual([
    { kind: "correction", sender: "automation", confidence: 0.9 },
  ]);
  expect(jev.tokens).toEqual({ input: 20, output: 4 });

  const confused = new Jev(
    "key",
    answering(200, () => ({ type: "choice", choice: "praise", confidence: 1, probabilities: {} })),
  );
  const [judgment] = await confused.classify([exchange("no")]);
  expect(judgment).toBeInstanceOf(Error);
});

test("a rejected key stops the whole batch", async () => {
  const jev = new Jev(
    "bad",
    answering(401, () => null),
  );
  expect(
    await jev.classify([exchange("a"), exchange("b")]).catch((e: unknown) => e),
  ).toBeInstanceOf(KeyRejected);
});
