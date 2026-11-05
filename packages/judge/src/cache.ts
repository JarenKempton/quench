import { createHash, randomUUID } from "node:crypto";
import { appendFile, link, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { jsonlLines } from "@quench/history";
import { z } from "zod";
import { Verdict, type Exchange } from "./verdict.ts";

/** One persisted reply classification in its judge's own file, separate from theme-grouping decisions. */
const Line = z.object({
  /** Judge identity, including its model and reply-question version. */
  judge: z.string(),
  /** SHA-256 of length-prefixed judge identity, full assistant text and full reply text. */
  key: z.string(),
  /** The original model answer, not the effective sender after harness/host evidence is applied. */
  verdict: Verdict,
  /** Copied from a shared file; any entry for the same key without this flag wins over it. */
  migrated: z.literal(true).optional(),
});

export class VerdictCache {
  private constructor(
    readonly path: string,
    readonly judge: string,
    private readonly known: Map<string, Verdict>,
    private readonly readOnly: boolean,
  ) {}

  static async open(dir: string, judge: string, readOnly = false): Promise<VerdictCache> {
    const path = join(dir, "judgments", fileName(judge));
    const legacy = merged(await read(await sharedFiles(dir), judge));
    const own = (await Bun.file(path).exists()) ? await read([path], judge) : null;
    const missing = [...legacy].filter(([key]) => !own?.migrated.has(key) && !own?.native.has(key));
    const known = new Map([...legacy, ...(own ? merged(own) : [])]);
    const cache = new VerdictCache(path, judge, known, readOnly);
    if (readOnly || missing.length === 0) return cache;
    if (own === null) return (await cache.create()) ? cache : VerdictCache.open(dir, judge);
    await cache.append(missing.map(([key, v]) => cache.line(key, v, true)));
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
    await this.append(lines);
  }

  private async append(lines: string[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const size = await stat(this.path).then(
      (s) => s.size,
      () => 0,
    );
    const partial =
      size > 0 &&
      (await Bun.file(this.path)
        .slice(size - 1)
        .text()) !== "\n";
    await appendFile(this.path, (partial ? "\n" : "") + lines.join(""));
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

  private line(key: string, verdict: Verdict, migrated = false): string {
    const fields = { judge: this.judge, key, verdict, ...(migrated ? { migrated } : {}) };
    return `${JSON.stringify(fields)}\n`;
  }

  private async create(): Promise<boolean> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, [...this.known].map(([key, v]) => this.line(key, v, true)).join(""));
    try {
      await link(tmp, this.path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await unlink(tmp);
    }
  }
}

async function sharedFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => []);
  return names
    .filter((name) => /^judgments(-[\w.-]+)?\.jsonl$/.test(name))
    .map((name) => join(dir, name));
}

const fileName = (judge: string) =>
  `${judge.replace(/[^\w.-]+/g, "_")}-${createHash("sha256").update(judge).digest("hex").slice(0, 16)}.jsonl`;

type Loaded = { native: Map<string, Verdict>; migrated: Map<string, Verdict> };

const merged = (loaded: Loaded) => new Map([...loaded.migrated, ...loaded.native]);

async function read(files: string[], judge: string): Promise<Loaded> {
  const loaded: Loaded = { native: new Map(), migrated: new Map() };
  for (const file of files) {
    for await (const line of jsonlLines(file, Line, { lines: 0, unparsed: 0 })) {
      if (line.judge === judge)
        (line.migrated ? loaded.migrated : loaded.native).set(line.key, line.verdict);
    }
  }
  return loaded;
}
