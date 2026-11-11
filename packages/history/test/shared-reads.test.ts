import { afterEach, expect, test } from "bun:test";
import { harnessById, readSessions, sharingReads, type SessionRef } from "../src/index.ts";

const claude = harnessById["claude-code"];
const original = Object.getOwnPropertyDescriptor(claude, "read")!;
let parsed: string[] = [];

const fake = () => {
  parsed = [];
  claude.read = async (ref: SessionRef) => {
    parsed.push(ref.path);
    await Bun.sleep(1);
    return { id: ref.path } as never;
  };
};
afterEach(() => Object.defineProperty(claude, "read", original));

const refs = (n: number): SessionRef[] =>
  Array.from({ length: n }, (_, i) => ({
    harness: "claude-code",
    path: `s${i}.jsonl`,
    modified: new Date(1000),
    parent: null,
  }));

const readAll = async (list: SessionRef[], stopAfter = Infinity) => {
  let seen = 0;
  for await (const outcome of readSessions(list)) {
    expect(outcome.ok).toBe(true);
    if (++seen >= stopAfter) break;
  }
  return seen;
};

test("readers running together while reads are shared parse each session once", async () => {
  fake();
  const list = refs(100);
  expect(
    await sharingReads(() => Promise.all([readAll(list), readAll(list), readAll(list)])),
  ).toEqual([100, 100, 100]);
  expect(parsed.sort()).toEqual(list.map((r) => r.path).sort());
});

test("a reader that stops early does not hold up the readers still going", async () => {
  fake();
  const list = refs(200);
  const read = sharingReads(() => Promise.all([readAll(list), readAll(list, 1)]));
  expect(await read).toEqual([200, 1]);
});

test("a session file that changed is parsed again", async () => {
  fake();
  const [first] = refs(1);
  const grown = { ...first!, modified: new Date(2000) };
  await sharingReads(() => Promise.all([readAll([first!]), readAll([grown])]));
  expect(parsed).toEqual(["s0.jsonl", "s0.jsonl"]);
});
