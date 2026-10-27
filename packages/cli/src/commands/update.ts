import { chmod, realpath, rename, rm } from "node:fs/promises";
import { assetName, channelOf, checksum, latest, type Channel, type Release } from "../releases.ts";

const RELEASES = "https://api.github.com/repos/JarenKempton/quench";

export type Install = {
  current: string;
  executable: string;
  compiled: boolean;
  platform: string;
  arch: string;
  api: string;
  token: string | null;
};

export function thisInstall(current: string): Install {
  return {
    current,
    executable: process.execPath,
    compiled: import.meta.path.startsWith("/$bunfs/"),
    platform: process.platform,
    arch: process.arch,
    api: process.env.QUENCH_RELEASES_API ?? RELEASES,
    token: process.env.GH_TOKEN || ghToken(),
  };
}

function ghToken(): string | null {
  try {
    const gh = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
    return gh.success ? gh.stdout.toString().trim() || null : null;
  } catch {
    return null;
  }
}

class Unreachable extends Error {}

async function get(install: Install, url: string, accept: string): Promise<Response> {
  const response = await fetch(url, {
    headers: {
      accept,
      ...(install.token ? { authorization: `Bearer ${install.token}` } : {}),
    },
  });
  if (!response.ok) throw new Unreachable(`HTTP ${response.status}`);
  return response;
}

export async function update(install: Install, requested?: Channel): Promise<number> {
  const log = (line: string) => process.stdout.write(`${line}\n`);
  const fail = (line: string) => (process.stderr.write(`${line}\n`), 1);
  if (!install.compiled)
    return fail("This quench runs from source. Update it with git pull, then bunx vp run compile.");
  const name = assetName(install.platform, install.arch);
  if (!name) return fail(`No quench release is built for ${install.platform}-${install.arch}.`);
  const channel = requested ?? channelOf(install.current);
  let releases: Release[];
  try {
    releases = (await (
      await get(install, `${install.api}/releases?per_page=50`, "application/vnd.github+json")
    ).json()) as Release[];
  } catch (error) {
    if (!(error instanceof Unreachable)) throw error;
    return fail(
      `Couldn't read Quench releases (${error.message}). The repository is private: sign in with gh auth login, or set GH_TOKEN.`,
    );
  }
  const release = latest(releases, channel);
  if (!release) return fail(`There is no ${channel} release yet.`);
  const target = release.tag_name.slice(1);
  const switching = channel !== channelOf(install.current);
  if (target === install.current || (!switching && Bun.semver.order(target, install.current) < 0)) {
    log(`quench ${install.current} is up to date (${channel}).`);
    return 0;
  }
  const binary = release.assets.find((a) => a.name === name);
  const sums = release.assets.find((a) => a.name === "SHA256SUMS");
  if (!binary || !sums)
    return fail(`${release.tag_name} has no ${name} download yet; try again in a few minutes.`);
  const octet = "application/octet-stream";
  const expected = checksum(await (await get(install, sums.url, octet)).text(), name);
  const bytes = await (await get(install, binary.url, octet)).bytes();
  const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (!expected || actual !== expected)
    return fail(`The ${name} download doesn't match its SHA256SUMS entry; nothing was changed.`);
  const executable = await realpath(install.executable);
  const staged = `${executable}.update-${process.pid}`;
  try {
    await Bun.write(staged, bytes);
    await chmod(staged, 0o755);
    await rename(staged, executable);
  } catch (error) {
    await rm(staged, { force: true });
    return fail(`Couldn't replace ${executable}: ${(error as Error).message}`);
  }
  log(`Updated quench ${install.current} → ${target} (${channel}).`);
  return 0;
}
