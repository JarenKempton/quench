import { afterAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DataDir } from "../src/data.ts";
import { receiveTranscript } from "../src/intake.ts";
import { temp } from "./helpers.ts";

const root = temp("intake");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const CHUNK = 64 * 1024;

test("a long stream of small chunks leaves no listeners behind on the decompressor", async () => {
  const raw = Buffer.from(randomBytes(40 * 1024 * 1024).toString("base64"));
  const compressed = Bun.zstdCompressSync(raw);
  expect(compressed.length / CHUNK).toBeGreaterThan(500);
  const warnings: string[] = [];
  const onWarning = (w: Error) => warnings.push(`${w.name}: ${w.message}`);
  process.on("warning", onWarning);
  async function* chunks() {
    for (let at = 0; at < compressed.length; at += CHUNK) yield compressed.subarray(at, at + CHUNK);
  }
  try {
    const data = await DataDir.open(join(root, "data"));
    const got = await receiveTranscript(data, chunks());
    expect(got.raw).toBe(raw.length);
    expect(got.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
    await Bun.sleep(0);
  } finally {
    process.off("warning", onWarning);
  }
  expect(warnings.filter((w) => w.includes("MaxListenersExceeded"))).toEqual([]);
}, 60_000);
