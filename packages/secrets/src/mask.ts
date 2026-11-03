import { createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { detectInFile, entropy } from "./detect.ts";

export type Masker = {
  id(value: string): string;
  tag(value: string): string;
  masked(value: string): string;
  scrubbed(text: string, width?: number): string;
};

const KEY_FILE = ".quench/local/secrets.key";

const LONG_WORD = /[A-Za-z0-9+=_-]{20,}/g;
const PASSWORD_ARG = /(?:^|\s)(?:-p|--password)(?:=|\s*)(['"]?)([^\s'"]+)\1/g;
const PASSWORD_VAR = /\b\w*PASS\w*=(['"]?)([^\s'"]+)\1/gi;

export async function machineKey(homeDir: string): Promise<Buffer> {
  const path = join(homeDir, KEY_FILE);
  const stored = await Bun.file(path)
    .text()
    .catch(() => null);
  if (stored && /^[0-9a-f]{64}$/.test(stored.trim())) return Buffer.from(stored.trim(), "hex");
  const key = randomBytes(32);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, key.toString("hex"));
  await chmod(path, 0o600);
  return key;
}

export function masker(key: Buffer): Masker {
  const id = (value: string) => createHmac("sha256", key).update(value).digest("hex");
  const tag = (value: string) => id(value).slice(0, 8);
  const masked = (value: string) => `${value.slice(0, 4)}…${tag(value)}`;
  const scrubbed = (text: string, width = 80) => {
    const values = new Set(detectInFile(text).map((d) => d.value));
    for (const pattern of [PASSWORD_ARG, PASSWORD_VAR])
      for (const match of text.matchAll(pattern)) values.add(match[2]!);
    let safe = text;
    for (const value of [...values].sort((a, b) => b.length - a.length))
      safe = safe.replaceAll(value, masked(value));
    safe = safe.replace(LONG_WORD, (word) => (entropy(word) >= 3.5 ? masked(word) : word));
    const line = safe.split(/\s+/).filter(Boolean).join(" ");
    return line.length > width ? `${line.slice(0, width)}…` : line;
  };
  return { id, tag, masked, scrubbed };
}
