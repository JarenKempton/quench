import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { jsonlLines } from "@quench/history";
import { z } from "zod";
import type { ThemeInput } from "./themes.ts";

/** One semantic grouping decision, not a theme summary or a reply-kind verdict. */
export const ThemeDecision = z.object({
  /** `new`, `unclear`, or an exemplar ID such as `t0`; checked against the current question's choices. */
  choice: z.string(),
  /** Actual model returned by the grouping service, not the coding-agent model being corrected. */
  model: z.string().min(1),
});
export type ThemeDecision = z.infer<typeof ThemeDecision>;

/** One JSONL record in the separate theme-decision cache; aggregate counts are rebuilt, not stored. */
const Line = z.object({
  /** Grouping judge identity, including requested model and question version. */
  judge: z.string(),
  /** SHA-256 of judge identity and the exact question, choices, current excerpt and ordered exemplars. */
  key: z.string(),
  /** Validated choice and the model that made it; failures are never cached. */
  decision: ThemeDecision,
});

type ChoiceInput = { choices: Record<string, string> };

export class ThemeCache<I extends ChoiceInput = ThemeInput> {
  readonly warnings: string[] = [];
  private constructor(
    readonly path: string,
    readonly judge: string,
    private readonly known: Map<string, ThemeDecision>,
  ) {}

  static async open<I extends ChoiceInput = ThemeInput>(
    path: string,
    judge: string,
  ): Promise<ThemeCache<I>> {
    const known = new Map<string, ThemeDecision>();
    const diagnostics = { lines: 0, unparsed: 0 };
    if (await Bun.file(path).exists()) {
      for await (const line of jsonlLines(path, Line, diagnostics)) {
        if (line.judge === judge) known.set(line.key, line.decision);
      }
    }
    const cache = new ThemeCache<I>(path, judge, known);
    if (diagnostics.unparsed) cache.warnings.push("Malformed theme cache records were ignored.");
    return cache;
  }

  get(input: I): ThemeDecision | undefined {
    const decision = this.known.get(this.key(input));
    return decision && Object.hasOwn(input.choices, decision.choice) ? decision : undefined;
  }

  async remember(input: I, value: ThemeDecision): Promise<void> {
    const decision = ThemeDecision.parse(value);
    if (!Object.hasOwn(input.choices, decision.choice)) throw new Error("Unknown theme choice");
    const key = this.key(input);
    await mkdir(dirname(this.path), { recursive: true });
    const file = Bun.file(this.path);
    const separator =
      (await file.exists()) && file.size > 0 && (await file.slice(-1).text()) !== "\n" ? "\n" : "";
    await appendFile(
      this.path,
      `${separator}${JSON.stringify({ judge: this.judge, key, decision })}\n`,
    );
    this.known.set(key, decision);
  }

  private key(input: I): string {
    return createHash("sha256")
      .update(JSON.stringify([this.judge, input]))
      .digest("hex");
  }
}
