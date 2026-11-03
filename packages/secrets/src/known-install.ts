import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type KnownInstall = { name: string; version: string; script: string; sha256: string };

export const KNOWN_INSTALLS: KnownInstall[] = [
  ["0.18.20", "f2172bde2cc557494e934e65434121c60c97009104e1075bb2ccc6a3d88d0962"],
  ["0.21.5", "68a0345fdf9db3c542e54fbdfb6d2214a0fce801871b3cf2c88ac71ceb1d6e06"],
  ["0.25.5", "9fbc7c98f72a1cc101b68dbb7f70b8458a70a317a909857d0d743d3b14fd2636"],
  ["0.25.12", "eeec141e9968a5c7edad75dab48f3e36717673ccf1cfc584ea98ecfba217a4c5"],
  ["0.27.0", "eeec141e9968a5c7edad75dab48f3e36717673ccf1cfc584ea98ecfba217a4c5"],
  ["0.27.7", "eeec141e9968a5c7edad75dab48f3e36717673ccf1cfc584ea98ecfba217a4c5"],
  ["0.28.0", "4cc6d14a33dcb234e27a65c74da227d0913ee955f4a17730b5d8fe5f84890676"],
  ["0.28.1", "3addeb5ee4f1195b41abdb001aa5961dbdbe6a80af3345a9cfadb9ab1506623b"],
  ["0.28.2", "3addeb5ee4f1195b41abdb001aa5961dbdbe6a80af3345a9cfadb9ab1506623b"],
].map(([version, sha256]) => ({
  name: "esbuild",
  version: version!,
  script: "postinstall",
  sha256: sha256!,
}));

const NODE_FILE = /^node ([\w-]+(?:\/[\w-]+)*\.c?js)$/;

export async function installHash(dir: string, command: string): Promise<string | null> {
  const file = NODE_FILE.exec(command)?.[1];
  const bytes = file ? await readFile(join(dir, file)).catch(() => null) : null;
  if (!bytes) return null;
  return createHash("sha256").update(command).update("\0").update(bytes).digest("hex");
}

export async function knownInstall(
  name: string,
  dir: string,
  script: string,
  command: string,
  known: readonly KnownInstall[] = KNOWN_INSTALLS,
): Promise<boolean> {
  const candidates = known.filter((k) => k.name === name && k.script === script);
  if (!candidates.length) return false;
  const hash = await installHash(dir, command);
  return candidates.some((k) => k.sha256 === hash);
}
