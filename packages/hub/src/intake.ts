import { createHash } from "node:crypto";
import { createZstdDecompress } from "node:zlib";
import { MAX_TRANSCRIPT_BYTES, MAX_UPLOAD_BYTES } from "@quench/fleet";
import { detect } from "@quench/secrets";
import type { DataDir } from "./data.ts";

export class Rejected extends Error {
  constructor(
    message: string,
    readonly status: 413 | 422 = 422,
  ) {
    super(message);
  }
}

const SCAN_AT = 1024 * 1024;
const LONG_LINE = 4 * 1024 * 1024;
const OVERLAP = 4096;

export class SecretScan {
  private text = "";
  private readonly decoder = new TextDecoder();
  private readonly seen = new Set<string>();
  readonly rules = new Set<string>();

  get findings() {
    return this.seen.size;
  }

  push(chunk: Uint8Array) {
    this.text += this.decoder.decode(chunk, { stream: true });
    if (this.text.length < SCAN_AT) return;
    const cut = this.text.lastIndexOf("\n");
    if (cut >= 0) {
      this.scan(this.text.slice(0, cut));
      this.text = this.text.slice(cut + 1);
    } else if (this.text.length > LONG_LINE) {
      this.scan(this.text);
      this.text = this.text.slice(-OVERLAP);
    }
  }

  end() {
    this.text += this.decoder.decode();
    this.scan(this.text);
    this.text = "";
  }

  private scan(text: string) {
    for (const found of detect(text)) {
      this.seen.add(createHash("sha256").update(found.value).digest("hex"));
      this.rules.add(found.rule);
    }
  }
}

export async function receiveTranscript(data: DataDir, body: AsyncIterable<Uint8Array>) {
  const tmp = ["tmp", `${crypto.randomUUID()}.zst`];
  const file = await data.create(tmp);
  const hash = createHash("sha256");
  const secrets = new SecretScan();
  const inflate = createZstdDecompress();
  let stored = 0;
  let raw = 0;
  let failure: Rejected | null = null;
  const fail = (error: Rejected) => {
    failure ??= error;
    inflate.destroy();
  };
  inflate.on("data", (chunk: Buffer) => {
    raw += chunk.length;
    if (raw > MAX_TRANSCRIPT_BYTES)
      return fail(
        new Rejected(`the transcript is over ${MAX_TRANSCRIPT_BYTES} bytes decompressed`, 413),
      );
    hash.update(chunk);
    secrets.push(chunk);
  });
  const drained = new Promise<void>((done, reject) => {
    inflate.on("end", done);
    inflate.on("error", () => reject(failure ?? new Rejected("the transcript is not zstd")));
    inflate.on("close", () => failure && reject(failure));
  });
  drained.catch(() => {});
  try {
    for await (const chunk of body) {
      stored += chunk.length;
      if (stored > MAX_UPLOAD_BYTES)
        fail(new Rejected(`the upload is over ${MAX_UPLOAD_BYTES} bytes compressed`, 413));
      if (failure) throw failure;
      await file.write(chunk);
      await new Promise<void>((done) => {
        if (!inflate.write(chunk, () => done())) inflate.once("drain", done);
        inflate.once("close", done);
      });
      if (failure) throw failure;
    }
    inflate.end();
    await drained;
    secrets.end();
    await file.close();
    return { tmp, stored, raw, sha256: hash.digest("hex"), secrets };
  } catch (error) {
    inflate.destroy();
    await file.close().catch(() => {});
    await data.remove(...tmp);
    throw error;
  }
}
