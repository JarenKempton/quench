import type { Detection } from "./detect.ts";
import type { Masker } from "./mask.ts";
import { rotateAt } from "./rotate.ts";

export type Secret = {
  id: string;
  tag: string;
  masked: string;
  rule: string;
  provider: string;
  confidence: "high" | "low";
  issuer: string | null;
  rotate: string | null;
};

const LOW_CONFIDENCE = new Set(["generic-api-key", "secret-named-value"]);

export const secretOf = (found: Detection, mask: Masker, where: string): Secret => {
  const low = LOW_CONFIDENCE.has(found.rule);
  return {
    id: findingId(mask, where, found.value),
    tag: mask.tag(found.value),
    masked: mask.masked(found.value),
    rule: found.rule,
    provider: found.provider,
    confidence: low ? "low" : "high",
    issuer: found.issuer,
    rotate: low ? null : rotateAt(found.provider),
  };
};

export const findingId = (mask: Masker, ...parts: string[]) =>
  mask.id(parts.join("\0")).slice(0, 16);

export async function textOf(path: string): Promise<string | null> {
  const file = Bun.file(path);
  const info = await file.stat().catch(() => null);
  return info?.isFile() ? file.text().catch(() => null) : null;
}

export async function tracked(path: string, dir: string): Promise<boolean | null> {
  const proc = Bun.spawn(["git", "-C", dir, "ls-files", "--error-unmatch", path], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await proc.exited.catch(() => null);
  return code === null ? null : code === 0;
}
