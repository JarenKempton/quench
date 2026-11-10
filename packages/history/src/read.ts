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

const shared = new Map<string, { modified: number | undefined; parsed: Promise<Session> }>();
let sharing = 0;

export async function sharingReads<T>(work: () => Promise<T>): Promise<T> {
  sharing++;
  try {
    return await work();
  } finally {
    if (--sharing === 0) shared.clear();
  }
}

const parse = (ref: SessionRef): Promise<Session> => {
  if (!sharing) return harnessById[ref.harness].read(ref);
  const key = `${ref.harness}:${ref.path}`;
  const modified = ref.modified?.getTime();
  const hit = shared.get(key);
  if (hit && hit.modified === modified) return hit.parsed;
  const parsed = harnessById[ref.harness].read(ref);
  shared.set(key, { modified, parsed });
  return parsed;
};

export async function* readSessions(
  refs: readonly SessionRef[],
  concurrency = 4,
  onRead: Progress = () => {},
): AsyncGenerator<ReadOutcome> {
  const read = (ref: SessionRef): Promise<ReadOutcome> =>
    parse(ref).then(
      (session) => ({ ok: true, session }),
      (error: unknown) => ({ ok: false, ref, error }),
    );
  const pending = refs.slice(0, concurrency).map(read);
  let next = pending.length;
  let done = 0;
  while (pending.length > 0) {
    const outcome = await pending.shift();
    const ref = refs[next++];
    if (ref) pending.push(read(ref));
    onRead(++done, refs.length);
    await letOthersRun();
    if (outcome) yield outcome;
  }
}
