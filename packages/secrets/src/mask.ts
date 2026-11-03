import { createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
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
const VALUE = `(?:'([^']*)'|"([^"]*)"|([^\\s'"]+))`;
const PASSWORDS = [
  new RegExp(`(?:^|\\s)(?:-p|--password)(?:=|\\s*)${VALUE}`, "g"),
  new RegExp(`\\b\\w*PASS\\w*=${VALUE}`, "gi"),
  new RegExp(`\\bredis-cli\\b(?:\\s+\\S+)*?\\s+(?:-a|--pass)\\s+${VALUE}`, "g"),
  /:\/\/[^\s:@/]+:([^\s@/]+)@/g,
];
const HTPASSWD = /\bhtpasswd((?:\s+(?:'[^']*'|"[^"]*"|[^\s|;&]+))+)/g;
const WORD = new RegExp(VALUE, "g");

export async function machineKey(homeDir: string): Promise<Buffer> {
  const path = join(homeDir, KEY_FILE);
  const stored = await Bun.file(path)
    .text()
    .catch(() => null);
  if (stored && /^[0-9a-f]{64}$/.test(stored.trim())) return Buffer.from(stored.trim(), "hex");
  const key = randomBytes(32);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, key.toString("hex"), { mode: 0o600 });
  await chmod(path, 0o600);
  return key;
}

export function masker(key: Buffer): Masker {
  const id = (value: string) => createHmac("sha256", key).update(value).digest("hex");
  const tag = (value: string) => id(value).slice(0, 8);
  const masked = (value: string) => `${value.slice(0, 4)}…${tag(value)}`;
  const scrubbed = (text: string, width = 80) => {
    const values = new Set(detectInFile(text).map((d) => d.value));
    for (const value of passwords(text)) values.add(value);
    let safe = text;
    for (const value of [...values].sort((a, b) => b.length - a.length))
      safe = safe.replaceAll(value, masked(value));
    safe = safe.replace(LONG_WORD, (word) => (entropy(word) >= 3.5 ? masked(word) : word));
    const line = safe.split(/\s+/).filter(Boolean).join(" ");
    return line.length > width ? `${line.slice(0, width)}…` : line;
  };
  return { id, tag, masked, scrubbed };
}

export function passwords(text: string): string[] {
  const found: string[] = [];
  for (const pattern of PASSWORDS)
    for (const match of text.matchAll(pattern)) found.push(quoted(match));
  for (const [, args] of text.matchAll(HTPASSWD)) {
    const words = [...args!.matchAll(WORD)].map(quoted);
    const positional = words.filter((word) => !word.startsWith("-"));
    if (words.some((word) => /^-\w*b/.test(word)) && positional.length >= 2)
      found.push(positional.at(-1)!);
  }
  return found.filter(Boolean);
}

const quoted = (match: RegExpMatchArray) => match.slice(1).find((part) => part) ?? "";
