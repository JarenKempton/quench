import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, SenderEvidence } from "@quench/history";
import { runs } from "@quench/insights";
import {
  Jev,
  KeyRejected,
  VerdictCache,
  judgeReplies,
  summarize,
  type Exchange,
  type SessionRuns,
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
        id: "s",
        path: "/unused",
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

test("host-marked and T3-formatted notices and recorded slash commands skip the judge; near misses and command-like text do not", async () => {
  const session = (reply: Event[]): SessionRuns => ({
    id: "s",
    path: "/unused",
    harness: "claude-code",
    cwd: null,
    runs: runs({
      id: "s",
      harness: "claude-code",
      path: "/unused",
      cwd: null,
      parent: null,
      diagnostics: { lines: 0, unparsed: 0 },
      events: [
        { type: "message", author: "user", origin: "unknown", text: "build", at: null },
        {
          type: "inference",
          model: null,
          effort: null,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          at: null,
        },
        { type: "message", author: "assistant", origin: "unknown", text: "done", at: null },
        ...reply,
      ],
    }),
  });
  const said = (text: string, sender?: SenderEvidence): Event[] => [
    {
      type: "message",
      author: "user",
      origin: "unknown",
      text,
      at: null,
      ...(sender ? { sender } : {}),
    },
  ];
  const command = (text: string, sender?: SenderEvidence): Event[] => [
    ...said(text, sender),
    { type: "invocation", name: text.slice(1).split(" ")[0]!, by: "user", at: null },
  ];
  const notices = [
    "Update on pull request #7 (https://github.com/acme/app/pull/7), which T3 Code is watching for you:\n- All 2 checks passed on abc1234.\n\nLook into each item and act on it as your task requires.",
    "Note: the T3 server restarted, and this background work was cancelled before it finished. It will not report back on its own, so resume or restart what you still need and wait for its result:\n- shell: Wait for the build (id abc)\n\nContinue where you left off.",
    "Note: the T3 server restarted, and this background work was cancelled before it finished. It will not report back:\n- subagent: Review the fix (id def)",
    "Delegated task node:delegated-task:command%3Amcp%3Aabc%3Adelegate-task%3Areview-r1 (Review (round 1)) [completed]:\nVERDICT: APPROVED",
    "Delegated task node:delegated-task:command%3Amcp%3Aabc%3Adelegate-task%3Afix [failed]:\nTimed out",
    "Delegated task node:delegated-task:x%3Ay reached a terminal state. Use task_status with taskId node:delegated-task:x%3Ay to read the result.",
  ];
  const commands = ["/compact", "/model gpt-test", "/review-pr https://github.com/acme/app/pull/7"];
  const nearMisses = [
    "update on pull request #7 (https://github.com/acme/app/pull/7), which T3 Code is watching for you:\n- no, that is wrong",
    "Here is my update on pull request #7, which T3 Code is watching for you: you broke the build.",
    "Note: the T3 server restarted, and this background work was cancelled before it finished. It will not report back:\n- shell: build\n\nUser message:\nno, use the other branch",
    "Delegated task node:delegated-task:x (review) [completed] was wrong, redo it",
    "/tmp is full, clean it",
    "/compact",
  ];
  const agent: SenderEvidence = { sender: "automation", source: "t3", messageId: "m" };
  const asked: Exchange[] = [];
  const judge = {
    id: "judge/v1",
    classify: async (exchanges: readonly Exchange[]) => {
      asked.push(...exchanges);
      return exchanges.map(() => verdict);
    },
  };
  const judged = await judgeReplies(
    [
      ...notices.map((text) => session(said(text))),
      session(said("Background task completed.", { ...agent, notice: true })),
      ...commands.map((text) => session(command(text))),
      ...nearMisses.map((text) => session(said(text))),
      session(command("/compact", agent)),
    ],
    await VerdictCache.open(await cachePath(), judge.id),
    judge,
  );
  expect(asked.map((e) => e.reply)).toEqual([...nearMisses, "/compact"]);
  expect(judged.replies.map((r) => `${r.kind} ${r.sender} ${r.senderSource}`)).toEqual([
    ...notices.map(() => "info automation host"),
    "info automation host",
    ...commands.map(() => "new_request person harness"),
    ...nearMisses.map(() => "correction person judge"),
    "correction automation host",
  ]);
});
