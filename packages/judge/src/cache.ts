import { createHash } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { jsonlLines } from "@quench/history";
import { z } from "zod";
import { Verdict, type Exchange } from "./verdict.ts";

/** One persisted reply classification in judgments.jsonl, separate from theme-grouping decisions. */
const Line = z.object({
  /** Judge identity, including its model and reply-question version. */
  judge: z.string(),
  /** SHA-256 of length-prefixed judge identity, full assistant text and full reply text. */
  key: z.string(),
  /** The original model answer, not the effective sender after harness/host evidence is applied. */
  verdict: Verdict,
});

export class VerdictCache {
  private constructor(
    readonly path: string,
    readonly judge: string,
    private readonly known: Map<string, Verdict>,
    private readonly readOnly: boolean,
  ) {}

  static async open(path: string, judge: string, readOnly = false): Promise<VerdictCache> {
    const known = new Map<string, Verdict>();
    const diagnostics = { lines: 0, unparsed: 0 };
    if (await Bun.file(path).exists()) {
      for await (const line of jsonlLines(path, Line, diagnostics)) {
        if (line.judge === judge) known.set(line.key, line.verdict);
      }
    }
    const cache = new VerdictCache(path, judge, known, readOnly);
    if (!readOnly && known.size < diagnostics.lines) await cache.rewrite();
    return cache;
  }

  get size(): number {
    return this.known.size;
  }

  get(exchange: Exchange): Verdict | undefined {
    return this.known.get(this.key(exchange));
  }

  async remember(fresh: readonly (readonly [Exchange, Verdict])[]): Promise<void> {
    if (fresh.length === 0) return;
    if (this.readOnly) throw new Error("Cannot write to a read-only verdict cache");
    const lines = fresh.map(([exchange, verdict]) => {
      const key = this.key(exchange);
      this.known.set(key, verdict);
      return this.line(key, verdict);
    });
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, lines.join(""));
  }

  private key(exchange: Exchange): string {
    const hash = createHash("sha256");
    for (const part of [this.judge, exchange.assistantSaid, exchange.reply]) {
      const bytes = Buffer.from(part);
      const length = Buffer.alloc(8);
      length.writeBigUInt64LE(BigInt(bytes.length));
      hash.update(length).update(bytes);
    }
    return hash.digest("hex");
  }

  private line(key: string, verdict: Verdict): string {
    return `${JSON.stringify({ judge: this.judge, key, verdict })}\n`;
  }

  private async rewrite(): Promise<void> {
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, [...this.known].map(([key, v]) => this.line(key, v)).join(""));
    await rename(tmp, this.path);
  }
}
