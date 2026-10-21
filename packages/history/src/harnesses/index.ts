import type { Harness } from "../harness.ts";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { pi } from "./pi.ts";

export const harnesses: readonly Harness[] = [claudeCode, codex, pi];
