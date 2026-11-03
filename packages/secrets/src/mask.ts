import { detect, entropy } from "./detect.ts";

export const fingerprint = (value: string) =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 16);

export const masked = (value: string) => `${value.slice(0, 4)}…${fingerprint(value).slice(0, 8)}`;

const LONG_WORD = /[A-Za-z0-9+=_-]{20,}/g;

export function scrubbed(text: string, width = 80): string {
  let safe = text;
  for (const { value } of detect(text)) safe = safe.replaceAll(value, masked(value));
  safe = safe.replace(LONG_WORD, (word) => (entropy(word) >= 3.5 ? masked(word) : word));
  const line = safe.split(/\s+/).filter(Boolean).join(" ");
  return line.length > width ? `${line.slice(0, width)}…` : line;
}
