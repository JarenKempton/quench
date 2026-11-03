import type { Ecosystem } from "@quench/history";

export type Unpinned = { reason: string; pinTo: string };

const EXACT = /^v?\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/;
const SHA = /^[0-9a-f]{40}$/i;
const DIGEST = /@sha256:[0-9a-f]{64}$/i;

export function unpinned(
  ecosystem: Ecosystem,
  spec: string,
  installed: string | null = null,
): Unpinned | null {
  if (ecosystem === "git") return gitPin(spec);
  if (ecosystem === "docker") return dockerPin(spec);
  if (ecosystem === "pypi") return pypiPin(spec, installed);
  return npmPin(spec, installed);
}

function npmPin(spec: string, installed: string | null): Unpinned | null {
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const version = at > 0 ? spec.slice(at + 1) : "";
  if (EXACT.test(version) && !version.startsWith("v")) return null;
  return { reason: versionReason(version), pinTo: `${name}@${installed ?? "<version>"}` };
}

function pypiPin(spec: string, installed: string | null): Unpinned | null {
  const [, name, op, version] =
    /^([\w.[\],-]+)(?:\s*(==|@|>=|~=|<=|>|<|!=)\s*(\S+))?$/.exec(spec) ?? [];
  if ((op === "==" || op === "@") && EXACT.test(version ?? "")) return null;
  const reason =
    op && op !== "@" && op !== "==" ? `range ${op}${version}` : versionReason(version ?? "");
  return { reason, pinTo: `${name ?? spec}==${installed ?? "<version>"}` };
}

function gitPin(spec: string): Unpinned | null {
  const [base, ref] = splitRef(spec);
  if (ref && (SHA.test(ref) || EXACT.test(ref))) return null;
  return { reason: ref ? `branch ${ref}` : "default branch", pinTo: `${base}#<commit-sha>` };
}

function dockerPin(spec: string): Unpinned | null {
  if (DIGEST.test(spec)) return null;
  const slash = spec.lastIndexOf("/");
  const colon = spec.lastIndexOf(":");
  const tag = colon > slash ? spec.slice(colon + 1) : "";
  const image = colon > slash ? spec.slice(0, colon) : spec;
  if (tag && tag !== "latest" && /\d/.test(tag)) return null;
  return { reason: tag ? `tag ${tag}` : "no tag", pinTo: `${image}@sha256:<digest>` };
}

function splitRef(spec: string): [string, string | null] {
  const hash = spec.indexOf("#");
  if (hash !== -1) return [spec.slice(0, hash), spec.slice(hash + 1).replace(/^semver:/, "")];
  const at = /^(git\+\S+?\.git)@([^@/]+)$/.exec(spec);
  return at ? [at[1]!, at[2]!] : [spec, null];
}

function versionReason(version: string): string {
  if (!version) return "no version";
  if (version === "latest") return "@latest";
  if (/^[\^~*><=x]|\|\|| - /.test(version) || /\.x\b|\.\*/.test(version)) return `range ${version}`;
  return `tag ${version}`;
}
