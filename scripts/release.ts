import { $ } from "bun";

export type Plan = {
  tag: string;
  version: string;
  sha: string;
  prerelease: boolean;
  previous: string;
};

const STABLE = /^v(\d+)\.(\d+)\.(\d+)$/;
const NIGHTLY = /^v(\d+\.\d+\.\d+)-nightly\.\d+\.\d+$/;
const BREAKING = /^\w+(\([^)]*\))?!:|^BREAKING[ -]CHANGE:/m;
const FEATURE = /^feat(\([^)]*\))?!?:/;

export function nextVersion(stable: string | null, messages: string[]): string {
  const match = stable && STABLE.exec(stable);
  if (!match) return "0.1.0";
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  const breaking = messages.some((m) => BREAKING.test(m));
  const feature = messages.some((m) => FEATURE.test(m));
  if (major === 0) return breaking || feature ? `0.${minor + 1}.0` : `0.${minor}.${patch + 1}`;
  if (breaking) return `${major + 1}.0.0`;
  return feature ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

export function nightlyVersion(base: string, day: Date, run: number): string {
  return `${base}-nightly.${day.toISOString().slice(0, 10).replaceAll("-", "")}.${run}`;
}

export function previewedVersion(nightlyTag: string): string | null {
  return NIGHTLY.exec(nightlyTag)?.[1] ?? null;
}

function newest(tags: string[], pattern: RegExp): string | null {
  const matching = tags.filter((t) => pattern.test(t));
  matching.sort((a, b) => Bun.semver.order(b.slice(1), a.slice(1)));
  return matching[0] ?? null;
}

async function tags(): Promise<string[]> {
  return (await $`git tag --list ${"v*"}`.text()).split("\n").filter(Boolean);
}

async function messagesSince(tag: string | null): Promise<string[]> {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  return (await $`git log --format=%B%x00 ${range}`.text())
    .split("\0")
    .map((m) => m.trim())
    .filter(Boolean);
}

async function commitOf(ref: string): Promise<string> {
  return (await $`git rev-list -n 1 ${ref}`.text()).trim();
}

export async function planNightly(run: number, day = new Date()): Promise<Plan> {
  const all = await tags();
  const stable = newest(all, STABLE);
  const version = nightlyVersion(nextVersion(stable, await messagesSince(stable)), day, run);
  return {
    tag: `v${version}`,
    version,
    sha: await commitOf("HEAD"),
    prerelease: true,
    previous: newest(all, NIGHTLY) ?? stable ?? "",
  };
}

export async function planStable(override: string): Promise<Plan> {
  const all = await tags();
  const nightly = newest(all, NIGHTLY);
  if (!nightly) throw new Error("No nightly release to promote yet.");
  const version = override || previewedVersion(nightly)!;
  if (!STABLE.test(`v${version}`)) throw new Error(`"${version}" is not a version like 1.2.3.`);
  if (all.includes(`v${version}`)) throw new Error(`v${version} is already released.`);
  const stable = newest(all, STABLE);
  if (stable && Bun.semver.order(version, stable.slice(1)) <= 0)
    throw new Error(`v${version} is not newer than ${stable}.`);
  return {
    tag: `v${version}`,
    version,
    sha: await commitOf(nightly),
    prerelease: false,
    previous: stable ?? "",
  };
}

if (import.meta.main) {
  const [channel, arg = ""] = process.argv.slice(2);
  const plan =
    channel === "nightly"
      ? await planNightly(Number(arg))
      : channel === "stable"
        ? await planStable(arg)
        : null;
  if (!plan) throw new Error("usage: bun scripts/release.ts nightly <run> | stable [version]");
  for (const [key, value] of Object.entries(plan)) process.stdout.write(`${key}=${value}\n`);
}
