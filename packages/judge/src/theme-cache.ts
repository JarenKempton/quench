import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { jsonlLines } from "@quench/history";
import { z } from "zod";
import type { ThemeInput } from "./themes.ts";

export const ThemeDecision = z.object({ choice: z.string(), model: z.string().min(1) });
export type ThemeDecision = z.infer<typeof ThemeDecision>;
const Line = z.object({ judge: z.string(), key: z.string(), decision: ThemeDecision });

export class ThemeCache {
  readonly warnings: string[] = [];
  private constructor(
    readonly path: string,
    readonly judge: string,
    private readonly known: Map<string, ThemeDecision>,
  ) {}

  static async open(path: string, judge: string): Promise<ThemeCache> {
    const known = new Map<string, ThemeDecision>();
    const diagnostics = { lines: 0, unparsed: 0 };
    if (await Bun.file(path).exists()) {
      for await (const line of jsonlLines(path, Line, diagnostics)) {
        if (line.judge === judge) known.set(line.key, line.decision);
      }
    }
    const cache = new ThemeCache(path, judge, known);
    if (diagnostics.unparsed) cache.warnings.push("Malformed theme cache records were ignored.");
    return cache;
  }

  get(input: ThemeInput): ThemeDecision | undefined {
    const decision = this.known.get(this.key(input));
    return decision && Object.hasOwn(input.choices, decision.choice) ? decision : undefined;
  }

  async remember(input: ThemeInput, value: ThemeDecision): Promise<void> {
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

  private key(input: ThemeInput): string {
    return createHash("sha256")
      .update(JSON.stringify([this.judge, input]))
      .digest("hex");
  }
}
