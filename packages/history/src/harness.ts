import type { Home } from "./home.ts";
import type { HarnessId, Session } from "./model.ts";

export type SessionRef = {
  harness: HarnessId;
  path: string;
  modified: Date | null;
  parent: string | null;
};

export interface Harness {
  readonly id: HarnessId;
  discover(home: Home): Promise<SessionRef[]>;
  read(ref: SessionRef): Promise<Session>;
}

export class NotASession extends Error {
  constructor(path: string, harness: string) {
    super(`${path} is not a ${harness} session`);
  }
}
