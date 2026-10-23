import { modified } from "./files.ts";
import type { Home } from "./home.ts";
import type { HarnessId, Session } from "./model.ts";
import type { McpEntry } from "./mcp.ts";
import type { SkillRoot } from "./skills.ts";
import type { SteeringRoot } from "./steering.ts";

export type SessionRef = {
  harness: HarnessId;
  path: string;
  modified: Date | null;
  parent: string | null;
};

export type HarnessHome = { variable: string; fallback: string };

export interface Harness<Id extends HarnessId = HarnessId> {
  readonly id: Id;
  readonly label: string;
  readonly home: HarnessHome;
  readonly sourceReads: boolean;
  readonly injectedInstructions: "per-file" | "combined";
  readonly skillUse: boolean;
  discover(home: Home): Promise<SessionRef[]>;
  read(ref: SessionRef): Promise<Session>;
  steering(home: Home, project: string): Promise<SteeringRoot[]>;
  skills(home: Home, project: string): Promise<SkillRoot[]>;
  mcp(home: Home, project: string): Promise<McpEntry[]>;
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
