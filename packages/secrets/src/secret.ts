import type { Detection } from "./detect.ts";
import { fingerprint, masked } from "./mask.ts";
import { rotateAt } from "./rotate.ts";

export type Secret = {
  fingerprint: string;
  masked: string;
  rule: string;
  provider: string;
  rotate: string | null;
};

export const secretOf = (found: Detection): Secret => ({
  fingerprint: fingerprint(found.value),
  masked: masked(found.value),
  rule: found.rule,
  provider: found.provider,
  rotate: rotateAt(found.provider),
});

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
