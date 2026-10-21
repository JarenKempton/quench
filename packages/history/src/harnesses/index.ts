import type { Harness } from "../harness.ts";
import type { HarnessId } from "../model.ts";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { pi } from "./pi.ts";

export const harnessById: { readonly [Id in HarnessId]: Harness<Id> } = {
  "claude-code": claudeCode,
  codex,
  pi,
};

export const harnesses: readonly Harness[] = Object.values(harnessById);
