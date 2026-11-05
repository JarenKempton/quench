import { randomBytes } from "node:crypto";
import { rmSync, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "quench-eval-";
const MARKER = "quench-eval.json";
const STALE_MS = 3_600_000;
const TOKEN = /^[0-9a-f]{64}$/;
const WATCH =
  'while kill -0 "-$2" 2>/dev/null; do kill -0 "$1" 2>/dev/null || { kill -KILL "-$2" 2>/dev/null; break; }; sleep 0.2; done; rm -rf -- "$3"; rm -f -- "$4"';

export type Scratch = { dir: string; entry: string };

const indexDir = () => join(homedir(), ".quench", "local", "eval-scratch");

const mine = (info: Stats | null) => {
  const uid = process.getuid?.();
  return info !== null && (uid === undefined || info.uid === uid);
};

const stat = (path: string) => lstat(path).catch(() => null);

async function ownedIndex(create: boolean): Promise<string | null> {
  const index = indexDir();
  if (create) await mkdir(index, { recursive: true, mode: 0o700 });
  const info = await stat(index);
  if (info?.isDirectory() && mine(info)) return index;
  if (create) throw new Error("Quench's scratch index is not a private folder");
  return null;
}

export async function createScratch(): Promise<Scratch> {
  const index = (await ownedIndex(true))!;
  const dir = await mkdtemp(join(tmpdir(), PREFIX));
  const token = randomBytes(32).toString("hex");
  const entry = join(index, token);
  await writeFile(entry, await realpath(dir), { flag: "wx", mode: 0o600 });
  await writeFile(
    join(dir, MARKER),
    JSON.stringify({ token, owner: process.pid, createdAt: Date.now() }),
    { flag: "wx", mode: 0o600 },
  );
  return { dir, entry };
}

export async function removeScratch(scratch: Scratch) {
  await rm(scratch.dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  await rm(scratch.entry, { force: true }).catch(() => undefined);
}

export function removeScratchNow(scratch: Scratch) {
  rmSync(scratch.dir, { recursive: true, force: true });
  rmSync(scratch.entry, { force: true });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

type Marker = { token: string; owner: number; createdAt: number };

const markerOf = (text: string): Marker | null => {
  try {
    const m = JSON.parse(text);
    return typeof m.token === "string" &&
      TOKEN.test(m.token) &&
      Number.isInteger(m.owner) &&
      Number.isFinite(m.createdAt)
      ? m
      : null;
  } catch {
    return null;
  }
};

async function owned(
  index: string,
  dir: string,
): Promise<{ marker: Marker; entry: string } | null> {
  const info = await stat(dir);
  if (!info?.isDirectory() || !mine(info)) return null;
  const file = join(dir, MARKER);
  const markerInfo = await stat(file);
  if (!markerInfo?.isFile() || !mine(markerInfo)) return null;
  const marker = markerOf(await readFile(file, "utf8").catch(() => ""));
  if (!marker) return null;
  const entry = join(index, marker.token);
  const entryInfo = await stat(entry);
  if (!entryInfo?.isFile() || !mine(entryInfo)) return null;
  const listed = await readFile(entry, "utf8").catch(() => null);
  const real = await realpath(dir).catch(() => null);
  return listed !== null && listed === real ? { marker, entry } : null;
}

export async function reclaimScratch(dir = tmpdir(), now = Date.now()) {
  const index = await ownedIndex(false);
  if (!index) return;
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(dir, name);
    const found = await owned(index, path);
    if (!found) continue;
    if (alive(found.marker.owner) && now - found.marker.createdAt <= STALE_MS) continue;
    await removeScratch({ dir: path, entry: found.entry });
  }
  for (const token of await readdir(index).catch(() => [])) {
    if (!TOKEN.test(token)) continue;
    const entry = join(index, token);
    if (!mine(await stat(entry))) continue;
    const listed = await readFile(entry, "utf8").catch(() => null);
    if (listed !== null && !(await stat(listed))) await rm(entry, { force: true });
  }
}

export function startWatchdog(group: number, dir: string, entry: string) {
  const watch = Bun.spawn(
    ["/bin/sh", "-c", WATCH, "quench-watchdog", String(process.pid), String(group), dir, entry],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true },
  );
  watch.unref();
  return watch;
}
