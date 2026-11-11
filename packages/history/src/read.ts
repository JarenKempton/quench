import type { SessionRef } from "./harness.ts";
import { harnessById, harnesses } from "./harnesses/index.ts";
import type { Home } from "./home.ts";
import type { Session } from "./model.ts";

export async function discoverAll(home: Home, since: Date | null = null): Promise<SessionRef[]> {
  const found = await Promise.all(harnesses.map((h) => h.discover(home)));
  return found.flat().filter((r) => !since || !r.modified || r.modified >= since);
}

export type Progress = (done: number, total: number) => void;

export type ReadOutcome =
  | { ok: true; session: Session }
  | { ok: false; ref: SessionRef; error: unknown };

const letOthersRun = () => Bun.sleep(0);

type Reader = { ahead: number };

type Shared = {
  modified: number | undefined;
  parsed: Promise<Session> | null;
  waiting: number;
  takers: Reader[];
};

const AHEAD = 32;
const RECHECK_MS = 1000;

const shared = new Map<string, Shared>();
let sharing = 0;
let released = Promise.withResolvers<void>();

export async function sharingReads<T>(work: () => Promise<T>): Promise<T> {
  sharing++;
  try {
    return await work();
  } finally {
    if (--sharing === 0) shared.clear();
  }
}

const keyOf = (ref: SessionRef) => `${ref.harness}:${ref.path}`;

const claim = (ref: SessionRef): Shared => {
  const modified = ref.modified?.getTime();
  let entry = shared.get(keyOf(ref));
  if (!entry || entry.modified !== modified) {
    entry = { modified, parsed: null, waiting: 0, takers: [] };
    shared.set(keyOf(ref), entry);
  }
  entry.waiting++;
  return entry;
};

const release = (ref: SessionRef, entry: Shared) => {
  if (shared.get(keyOf(ref)) === entry) shared.delete(keyOf(ref));
  entry.parsed = null;
  for (const taker of entry.takers) taker.ahead--;
  released.resolve();
  released = Promise.withResolvers<void>();
};

async function take(ref: SessionRef, entry: Shared, reader: Reader): Promise<Session> {
  while (!entry.parsed && reader.ahead >= AHEAD)
    await Promise.race([released.promise, Bun.sleep(RECHECK_MS)]);
  const parsed = (entry.parsed ??= harnessById[ref.harness].read(ref));
  if (--entry.waiting > 0) {
    entry.takers.push(reader);
    reader.ahead++;
  } else {
    const done = () => release(ref, entry);
    parsed.then(done, done);
  }
  return parsed;
}

export async function* readSessions(
  refs: readonly SessionRef[],
  concurrency = 4,
  onRead: Progress = () => {},
): AsyncGenerator<ReadOutcome> {
  const claims = sharing ? refs.map(claim) : null;
  const reader: Reader = { ahead: 0 };
  const read = (ref: SessionRef, i: number): Promise<ReadOutcome> =>
    (claims ? take(ref, claims[i]!, reader) : harnessById[ref.harness].read(ref)).then(
      (session) => ({ ok: true, session }),
      (error: unknown) => ({ ok: false, ref, error }),
    );
  const pending = refs.slice(0, concurrency).map((ref, i) => read(ref, i));
  let next = pending.length;
  let done = 0;
  while (pending.length > 0) {
    const outcome = await pending.shift();
    const ref = refs[next];
    if (ref) pending.push(read(ref, next));
    next++;
    onRead(++done, refs.length);
    await letOthersRun();
    if (outcome) yield outcome;
  }
}
