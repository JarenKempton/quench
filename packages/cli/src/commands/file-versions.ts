import { createHash } from "node:crypto";
import { chmod, mkdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type Span = { treeHash: string; from: number; until: number | null; bytes: number | null };

export type Versions = { source: "git" | "snapshots"; spans: Span[] };

const FILE = ".quench/local/snapshots.json";
export const DELETED = /^0+$/;
const GIT_TIMEOUT_MS = 10_000;

type Seen = { sha256: string; bytes: number; first: number; last: number };
type Stored = { v: 1; files: Record<string, Seen[]> };

const OFF = [
  "log.showSignature=false",
  "gpg.program=false",
  "gpg.ssh.program=false",
  "gpg.x509.program=false",
  "core.fsmonitor=false",
  "core.pager=cat",
  "diff.external=",
  "core.hooksPath=/dev/null",
  "log.mailmap=false",
  "protocol.allow=never",
  "core.sshCommand=false",
].flatMap((setting) => ["-c", setting]);

const isolated = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
});

function git(dir: string, args: string[], input?: string): string | null {
  const result = Bun.spawnSync(
    ["git", "--no-optional-locks", "--no-pager", ...OFF, "-C", dir, ...args],
    {
      env: isolated(),
      stdin: input === undefined ? "ignore" : Buffer.from(input),
      stdout: "pipe",
      stderr: "ignore",
      timeout: GIT_TIMEOUT_MS,
    },
  );
  return result.success ? result.stdout.toString() : null;
}

const blobId = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

export async function gitVersions(path: string): Promise<Span[] | null> {
  const dir = dirname(path);
  const log = git(dir, [
    "log",
    "--no-show-signature",
    "--no-ext-diff",
    "--no-textconv",
    "--format=@%ct",
    "--raw",
    "--no-abbrev",
    "--",
    basename(path),
  ]);
  if (!log) return null;
  const commits: { at: number; blob: string }[] = [];
  let at: number | null = null;
  for (const line of log.split("\n")) {
    if (line.startsWith("@")) at = Number(line.slice(1)) * 1000;
    else if (line.startsWith(":") && at !== null) {
      commits.push({ at, blob: line.split("\t")[0]!.split(" ")[3]! });
      at = null;
    }
  }
  if (!commits.length) return null;
  commits.reverse();
  for (let i = 1; i < commits.length; i++)
    commits[i]!.at = Math.max(commits[i]!.at, commits[i - 1]!.at);
  const blobs = [...new Set(commits.map((c) => c.blob).filter((b) => !DELETED.test(b)))];
  const sizes = new Map<string, number>();
  for (const line of (git(dir, ["cat-file", "--batch-check"], `${blobs.join("\n")}\n`) ?? "").split(
    "\n",
  )) {
    const [id, type, size] = line.split(" ");
    if (id && type === "blob") sizes.set(id, Number(size));
  }
  const spans: Span[] = commits.map((c, i) => ({
    treeHash: c.blob,
    from: c.at,
    until: commits[i + 1]?.at ?? null,
    bytes: sizes.get(c.blob) ?? null,
  }));
  const last = spans.at(-1)!;
  const disk = await Bun.file(path)
    .bytes()
    .catch(() => null);
  if (disk && blobId(disk) !== last.treeHash) {
    const changed = Math.max((await stat(path)).mtimeMs, last.from);
    last.until = changed;
    spans.push({ treeHash: blobId(disk), from: changed, until: null, bytes: disk.length });
  }
  return spans;
}

export async function snapshots(homeDir: string, write: boolean) {
  const file = join(homeDir, FILE);
  const stored = (await Bun.file(file)
    .json()
    .catch(() => null)) as Stored | null;
  const files = stored?.v === 1 ? stored.files : {};
  let changed = false;
  const now = Date.now();
  return {
    async versions(path: string): Promise<Span[]> {
      const bytes = await Bun.file(path)
        .bytes()
        .catch(() => null);
      const seen = (files[path] ??= []);
      if (bytes && write) {
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const latest = seen.at(-1);
        if (latest?.sha256 === sha256) latest.last = now;
        else seen.push({ sha256, bytes: bytes.length, first: now, last: now });
        changed = true;
      }
      if (!seen.length) delete files[path];
      return seen.map((s) => ({
        treeHash: s.sha256,
        from: s.first,
        until: s.last + 1,
        bytes: s.bytes,
      }));
    },
    async save() {
      if (!changed) return;
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${crypto.randomUUID()}`;
      await Bun.write(temporary, JSON.stringify({ v: 1, files } satisfies Stored));
      await chmod(temporary, 0o600);
      await rename(temporary, file);
    },
  };
}

export async function versionsOf(
  path: string,
  recorded: Awaited<ReturnType<typeof snapshots>>,
): Promise<Versions> {
  const tracked = await gitVersions(path);
  return tracked
    ? { source: "git", spans: tracked }
    : { source: "snapshots", spans: await recorded.versions(path) };
}
