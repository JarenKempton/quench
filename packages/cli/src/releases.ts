export type Channel = "stable" | "nightly";

export type Asset = { name: string; url: string };
export type Release = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: Asset[];
};

export function channelOf(version: string): Channel {
  return version.includes("-nightly.") ? "nightly" : "stable";
}

export function latest(releases: Release[], channel: Channel): Release | null {
  const matching = releases.filter(
    (r) =>
      !r.draft && channelOf(r.tag_name) === channel && r.prerelease === (channel === "nightly"),
  );
  matching.sort((a, b) => Bun.semver.order(b.tag_name.slice(1), a.tag_name.slice(1)));
  return matching[0] ?? null;
}

export function assetName(platform: string, arch: string): string | null {
  if (platform !== "linux" && platform !== "darwin") return null;
  if (arch !== "x64" && arch !== "arm64") return null;
  return `quench-${platform}-${arch}`;
}

export function checksum(sums: string, name: string): string | null {
  for (const line of sums.split("\n")) {
    const [hash, file] = line.trim().split(/\s+\*?/);
    if (file === name && hash) return hash;
  }
  return null;
}
