import type { Harness, SessionRef } from "./harness.ts";
import { harnesses } from "./harnesses/index.ts";
import type { Home } from "./home.ts";
import type { Session } from "./model.ts";

export async function discoverAll(home: Home, since: Date | null = null): Promise<SessionRef[]> {
  const found = await Promise.all(harnesses.map((h) => h.discover(home)));
  return found.flat().filter((r) => !since || !r.modified || r.modified >= since);
}

export type ReadOutcome =
  | { ok: true; session: Session }
  | { ok: false; ref: SessionRef; error: unknown };

export async function* readSessions(
  refs: readonly SessionRef[],
  concurrency = 4,
): AsyncGenerator<ReadOutcome> {
  const byId = new Map<string, Harness>(harnesses.map((h) => [h.id, h]));
  const read = (ref: SessionRef): Promise<ReadOutcome> => {
    const harness = byId.get(ref.harness);
    if (!harness)
      return Promise.resolve({ ok: false, ref, error: new Error(`no harness ${ref.harness}`) });
    return harness.read(ref).then(
      (session) => ({ ok: true, session }),
      (error: unknown) => ({ ok: false, ref, error }),
    );
  };
  const pending = refs.slice(0, concurrency).map(read);
  let next = pending.length;
  while (pending.length > 0) {
    const outcome = await pending.shift();
    const ref = refs[next++];
    if (ref) pending.push(read(ref));
    if (outcome) yield outcome;
  }
}
