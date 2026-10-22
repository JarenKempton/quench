import { modified } from "./files.ts";
import type { Home } from "./home.ts";
import type { HarnessId, Session } from "./model.ts";
import type { SteeringRoot } from "./steering.ts";

export type SessionRef = {
  harness: HarnessId;
  path: string;
  modified: Date | null;
  parent: string | null;
};

export interface Harness<Id extends HarnessId = HarnessId> {
  readonly id: Id;
  readonly label: string;
  discover(home: Home): Promise<SessionRef[]>;
  read(ref: SessionRef): Promise<Session>;
  steering(home: Home, project: string): Promise<SteeringRoot[]>;
}

export async function sessionRef(
  harness: HarnessId,
  path: string,
  parent: string | null = null,
): Promise<SessionRef> {
  return { harness, path, modified: await modified(path), parent };
}

export class NotASession extends Error {
  constructor(path: string, harness: string) {
    super(`${path} is not a ${harness} session`);
  }
}
