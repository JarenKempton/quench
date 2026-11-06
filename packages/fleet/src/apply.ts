import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { BundleManifest } from "./bundle.ts";
import { own, Sha256, TreeHash } from "./common.ts";
import { installedTree } from "./disk.ts";
import { LedgerEntry, owned } from "./ledger.ts";
import {
  executablesOf,
  type InstalledState,
  type Plan,
  type PlanItem,
  type ProjectCheckout,
} from "./plan.ts";
import { FileMode, sha256, treeHash, treeHashOf, type HashedEntry } from "./tree-hash.ts";

export class Conflict extends Error {}

const Exclude = z.object({ file: z.string(), line: z.string(), added: z.boolean() }).strict();
type Exclude = z.infer<typeof Exclude>;

export const JournalOp = z
  .object({
    sequence: z.number().int().nonnegative(),
    kind: z.enum(["install", "update", "remove"]),
    path: z.string(),
    base: z.string(),
    pin: z.string(),
    work: z.string(),
    token: z.string(),
    stage: z.string().nullable(),
    backup: z.string(),
    stagedId: z.string().nullable(),
    backupId: z.string().nullable(),
    desired: TreeHash.nullable(),
    previous: TreeHash.nullable(),
    previousExecutables: z.array(z.string()).nullable(),
    files: z.array(z.object({ path: z.string(), mode: FileMode, sha256: Sha256 }).strict()),
    exclude: Exclude.nullable(),
  })
  .strict();
export type JournalOp = z.infer<typeof JournalOp>;

export const MARKER = ".quench-owner";
const LOCK_LIMIT_MS = 60 * 60 * 1000;
const BREAKER_LIMIT_MS = 60 * 1000;
const CREATE_TRIES = 40;
const CREATE_RETRY_MS = 25;

export const statePaths = (state: string) => ({
  ledger: join(state, "ledger.json"),
  journal: join(state, "journal.json"),
  lock: join(state, "lock"),
});

const probe = (path: string) =>
  lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });

type Want = "dir" | "absent" | "dir?" | "file?";

export const pinKey = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

export const samePath = (a: string, b: string) => pinKey(a) === pinKey(b);

export async function resolved(path: string) {
  const missing: string[] = [];
  let at = path;
  for (;;) {
    const real = await realpath(at).catch(() => null);
    if (real) return join(real, ...missing.reverse());
    const up = dirname(at);
    if (up === at) return path;
    missing.push(basename(at));
    at = up;
  }
}

export const identity = async (path: string) => {
  const info = await lstat(path, { bigint: true }).catch(() => null);
  return info ? `${info.dev}:${info.ino}` : null;
};

export async function guard(base: string, path: string, want: Want, pin: string = base) {
  const rel = relative(base, path);
  if (isAbsolute(rel) || rel.split(/[\\/]/)[0] === "..")
    throw new Conflict(`${path} is outside ${base}`);
  const parts = rel ? rel.split(sep) : [];
  let at = base;
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) at = join(at, parts[i - 1]!);
    const last = i === parts.length;
    const info = await probe(at);
    if (!info) {
      if (want !== "dir") break;
      throw new Conflict(`${at} is missing`);
    }
    if (info.isSymbolicLink())
      throw new Conflict(`${at} is a symlink Quench did not create; it is never followed`);
    const ok = last && want === "file?" ? info.isFile() : info.isDirectory();
    if (!ok)
      throw new Conflict(`${at} is not a regular ${last && want === "file?" ? "file" : "folder"}`);
    if (last && want === "absent") throw new Conflict(`${at} already exists`);
  }
  const now = await resolved(base);
  if (!samePath(now, pin))
    throw new Conflict(`${base} now resolves to ${now}, not ${pin} as planned`);
}

async function rawWalk(root: string) {
  const files: HashedEntry[] = [];
  const dirs: string[] = [];
  const walk = async (rel: string) => {
    for (const name of await readdir(rel ? join(root, rel) : root)) {
      const path = rel ? `${rel}/${name}` : name;
      const full = join(root, ...path.split("/"));
      const info = await lstat(full);
      if (info.isDirectory()) {
        dirs.push(path);
        await walk(path);
      } else if (info.isSymbolicLink())
        files.push({
          path,
          mode: "120000",
          sha256: sha256(await readlink(full, { encoding: "buffer" })),
        });
      else if (info.isFile())
        files.push({
          path,
          mode: process.platform !== "win32" && info.mode & 0o111 ? "100755" : "100644",
          sha256: sha256(await readFile(full)),
        });
      else throw new Conflict(`${full} is not a file, folder or symlink`);
    }
  };
  await walk("");
  return { files, dirs };
}

const impliedDirs = (paths: string[]) =>
  new Set(
    paths.flatMap((p) =>
      p
        .split("/")
        .slice(0, -1)
        .map((_, i, a) => a.slice(0, i + 1).join("/")),
    ),
  );

export async function rawState(path: string): Promise<InstalledState | undefined> {
  const info = await lstat(path).catch(() => null);
  if (!info) return undefined;
  if (info.isSymbolicLink()) return { treeHash: treeHashOf([]), symlink: true, executables: null };
  const { files, dirs } = await rawWalk(path);
  const implied = impliedDirs(files.map((f) => f.path));
  const extra = dirs.filter((d) => !implied.has(d)).sort();
  const hash = treeHashOf(files);
  return {
    treeHash: extra.length ? `sha256:${sha256(`${hash}\0${extra.join("\0")}`)}` : hash,
    symlink: false,
    executables:
      process.platform === "win32"
        ? null
        : files
            .filter((f) => f.mode === "100755")
            .map((f) => f.path)
            .sort(),
  };
}

export async function inspect(path: string) {
  const info = await lstat(path).catch(() => null);
  if (!info) return undefined;
  if (info.isSymbolicLink() && !(await realpath(path).catch(() => null)))
    return { treeHash: treeHash([]), symlink: true, executables: null };
  return installedTree(path);
}

const matches = (
  now: InstalledState | undefined,
  hash: string | null | undefined,
  executables: string[] | null,
) =>
  hash
    ? !!now &&
      !now.symlink &&
      now.treeHash === hash &&
      (now.executables === null ||
        executables === null ||
        now.executables.join("\0") === executables.join("\0"))
    : !now;

async function writeAtomic(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, text, { flag: "wx" });
  await rename(temp, path);
}

async function readJson(path: string) {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return text === null ? null : JSON.parse(text);
}

export async function readLedger(state: string): Promise<LedgerEntry[]> {
  return z.array(LedgerEntry).parse((await readJson(statePaths(state).ledger)) ?? []);
}

const writeLedger = (state: string, entries: LedgerEntry[]) =>
  writeAtomic(statePaths(state).ledger, `${JSON.stringify(entries, null, 2)}\n`);

export async function readJournal(state: string): Promise<JournalOp | null> {
  const value = await readJson(statePaths(state).journal);
  return value === null ? null : JournalOp.parse(value);
}

const writeJournal = async (state: string, op: JournalOp | null) =>
  op
    ? writeAtomic(statePaths(state).journal, JSON.stringify(op))
    : rm(statePaths(state).journal, { force: true });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const LockInfo = z
  .object({ pid: z.number().int().positive(), host: z.string(), startedAt: z.iso.datetime() })
  .strict();

const deletePending = (error: NodeJS.ErrnoException) =>
  process.platform === "win32" && (error.code === "EPERM" || error.code === "EACCES");

async function create(path: string, text: string) {
  for (let tries = 1; ; tries++) {
    try {
      return await writeFile(path, text, { flag: "wx" });
    } catch (error) {
      if (!deletePending(error as NodeJS.ErrnoException) || tries === CREATE_TRIES) throw error;
      await sleep(CREATE_RETRY_MS);
    }
  }
}

const busy = (detail: string) => new Error(`another apply is running (${detail})`);

async function breakStale(lock: string) {
  const breaker = `${lock}.break`;
  const claim = () => create(breaker, String(process.pid));
  const claimed = await claim().then(
    () => true,
    async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      const since = await stat(breaker).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (since < BREAKER_LIMIT_MS) return false;
      await rm(breaker, { force: true });
      return claim().then(
        () => true,
        () => false,
      );
    },
  );
  if (!claimed) throw busy("another process is checking the lock");
  try {
    const text = await readFile(lock, "utf8").catch(() => null);
    if (text === null) return;
    let info;
    try {
      info = LockInfo.parse(JSON.parse(text));
    } catch {
      throw busy(`${lock} is not complete yet; remove it only if no apply is running`);
    }
    const dead = info.host === hostname() && !alive(info.pid);
    const old = Date.now() - Date.parse(info.startedAt) > LOCK_LIMIT_MS;
    if (!dead && !old) throw busy(`pid ${info.pid} on ${info.host}`);
    if ((await readFile(lock, "utf8").catch(() => null)) === text) await rm(lock, { force: true });
  } finally {
    await rm(breaker, { force: true });
  }
}

export async function withLock<T>(state: string, work: () => Promise<T>): Promise<T> {
  await mkdir(state, { recursive: true });
  const { lock } = statePaths(state);
  const mine = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
  });
  const take = () => create(lock, mine);
  await take().catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    await breakStale(lock);
    await take().catch((again: NodeJS.ErrnoException) => {
      throw again.code === "EEXIST" ? busy("lock taken") : again;
    });
  });
  try {
    return await work();
  } finally {
    if ((await readFile(lock, "utf8").catch(() => null)) === mine) await rm(lock, { force: true });
  }
}

const excludeConflict = (error: unknown) =>
  error instanceof Conflict ? new Conflict(`.git/info/exclude: ${error.message}`) : error;

async function guardExclude(file: string) {
  const git = dirname(dirname(file));
  await guard(git, file, "file?", git).catch((error) => {
    throw excludeConflict(error);
  });
}

async function excludeHas({ file, line }: { file: string; line: string }) {
  await guardExclude(file);
  return (await readFile(file, "utf8").catch(() => "")).split(/\r?\n/).includes(line);
}

async function addExclude({ file, line }: Exclude) {
  await guardExclude(file);
  const text = await readFile(file, "utf8").catch(() => "");
  if (text.split(/\r?\n/).includes(line)) return;
  await writeAtomic(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
  await guardExclude(file);
}

async function dropExclude({ file, line, added }: Exclude, ledger: LedgerEntry[]) {
  if (!added || [...owned(ledger).values()].some((e) => e.gitExclude === line)) return;
  await guardExclude(file);
  const lines = (await readFile(file, "utf8").catch(() => "")).split(/\r?\n/);
  if (lines.includes(line)) await writeAtomic(file, lines.filter((l) => l !== line).join("\n"));
  await guardExclude(file);
}

const removeTree = (path: string) => rm(path, { recursive: true, force: true });

async function stagedByUs(op: JournalOp) {
  const tree = await rawWalk(op.stage!).catch(() => null);
  if (!tree) return false;
  const files = new Map(op.files.map((f) => [f.path, f]));
  const implied = impliedDirs(op.files.map((f) => f.path));
  return (
    tree.dirs.every((d) => implied.has(d)) &&
    tree.files.every((entry) => {
      const file = files.get(entry.path);
      return (
        !!file &&
        file.sha256 === entry.sha256 &&
        (file.mode === "120000") === (entry.mode === "120000")
      );
    })
  );
}

const placedExecutables = (op: JournalOp) =>
  op.files
    .filter((f) => f.mode === "100755")
    .map((f) => f.path)
    .sort();

async function backedUp(op: JournalOp, conflict: (why: string) => Conflict) {
  await guard(op.base, op.backup, "dir", op.pin);
  if (!op.backupId || (await identity(op.backup)) !== op.backupId)
    throw conflict(`${op.backup} is not the folder Quench moved aside`);
  if (!matches(await rawState(op.backup), op.previous, op.previousExecutables))
    throw conflict(`${op.backup} changed after Quench moved it aside`);
}

async function tidy(op: JournalOp) {
  if (!(await probe(op.work))) return;
  const conflict = (why: string) =>
    new Conflict(
      `conflict: ${why}; Quench left it in place (interrupted ${op.kind} of ${op.path})`,
    );
  await guard(op.base, op.work, "dir", op.pin);
  const marker = await readFile(join(op.work, MARKER), "utf8").catch(() => null);
  const names = (await readdir(op.work)).filter((n) => n !== MARKER);
  if (marker !== op.token && (marker !== null || names.length))
    throw conflict(`${op.work} is not marked as created by this apply`);
  for (const name of names) {
    const path = join(op.work, name);
    await guard(op.base, path, "dir", op.pin);
    const id = await identity(path);
    if (path === op.backup) {
      await backedUp(op, conflict);
    } else if (path === op.stage) {
      if (id !== op.stagedId || !(await stagedByUs(op))) throw conflict(`${path} changed`);
    } else throw conflict(`${path} was not created by Quench`);
    await removeTree(path);
  }
  await rm(join(op.work, MARKER), { force: true });
  await rmdir(op.work);
}

export async function recover(state: string): Promise<string | null> {
  const op = await readJournal(state);
  if (!op) return null;
  const ledger = await readLedger(state);
  const conflict = (why: string) =>
    new Conflict(
      `conflict: ${why}; Quench left it in place (interrupted ${op.kind} of ${op.path})`,
    );
  const wrap = async (step: () => Promise<void>) =>
    step().catch((error) => {
      throw error instanceof Conflict && !error.message.startsWith("conflict:")
        ? conflict(error.message)
        : error;
    });
  if (ledger.some((e) => e.sequence === op.sequence)) {
    if (op.kind === "remove" && op.exclude) await wrap(() => dropExclude(op.exclude!, ledger));
  } else
    await wrap(async () => {
      const placed = async () => {
        await guard(op.base, op.path, "dir", op.pin);
        if (!op.stagedId || (await identity(op.path)) !== op.stagedId)
          throw conflict(`${op.path} was created by someone else after the interrupted apply`);
        if (!matches(await rawState(op.path), op.desired, placedExecutables(op)))
          throw conflict(`${op.path} was edited after the interrupted apply`);
      };
      if (await probe(op.backup)) {
        await backedUp(op, conflict);
        if (await probe(op.path)) {
          await placed();
          await removeTree(op.path);
        }
        await guard(op.base, op.path, "absent", op.pin);
        await rename(op.backup, op.path);
        await guard(op.base, op.path, "dir", op.pin);
      } else if (op.kind === "install" && (await probe(op.path))) {
        await placed();
        await removeTree(op.path);
      }
      if (op.kind === "install" && op.exclude) await dropExclude(op.exclude, ledger);
    });
  await wrap(() => tidy(op));
  await writeJournal(state, null);
  return `recovered an interrupted ${op.kind} of ${op.path}`;
}

async function stage(op: JournalOp, source: string) {
  for (const file of op.files) {
    const from = join(source, ...file.path.split("/"));
    const to = join(op.stage!, ...file.path.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await guard(op.base, dirname(to), "dir", op.pin);
    const bytes =
      file.mode === "120000" ? await readlink(from, { encoding: "buffer" }) : await readFile(from);
    if (sha256(bytes) !== file.sha256)
      throw new Error(`${from} changed since the plan; plan again`);
    if (file.mode === "120000") await symlink(bytes.toString(), to);
    else await writeFile(to, bytes, { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 });
  }
}

export type ApplyInput = {
  plan: Plan;
  bundle: BundleManifest;
  sources: Record<string, string>;
  state: string;
  absolute: (path: string) => string;
  installed: Record<string, InstalledState | undefined>;
  pins?: Record<string, string>;
  projects?: (ProjectCheckout & { exclude: string })[];
  now?: () => string;
  interrupt?: (step: "staged" | "backed-up" | "swapped" | "committed") => void | Promise<void>;
};

export type ApplyResult = {
  applied: PlanItem[];
  conflicts: { path: string; reason: string }[];
};

export const ACTIONABLE = ["install", "update", "remove"] as const;

export async function applyPlan(input: ApplyInput): Promise<ApplyResult> {
  const result: ApplyResult = { applied: [], conflicts: [] };
  for (const item of input.plan.items) {
    if (!(ACTIONABLE as readonly string[]).includes(item.action) || !item.path) continue;
    try {
      await applyItem(input, item);
      result.applied.push(item);
    } catch (error) {
      if (!(error instanceof Conflict)) throw error;
      result.conflicts.push({ path: item.path, reason: error.message });
      await recover(input.state);
    }
  }
  return result;
}

async function applyItem(input: ApplyInput, item: PlanItem) {
  const { bundle, state, absolute, interrupt } = input;
  const ledger = await readLedger(state);
  const kind = item.action as JournalOp["kind"];
  const path = absolute(item.path!);
  const root = dirname(path);
  const ours = owned(ledger).get(item.path!);
  const at = item.location;
  const checkout =
    at.scope === "project" ? input.projects?.find((p) => p.checkout === at.checkout) : undefined;
  if (at.scope === "project" && !checkout)
    throw new Conflict(`${item.path}: checkout ${at.checkout} was not given`);
  const base = checkout ? absolute(checkout.checkout) : root;
  const pin = input.pins?.[pinKey(base)] ?? base;
  const check = (target: string, want: Want) => guard(base, target, want, pin);
  const line = checkout ? `/${relative(base, path).replaceAll("\\", "/")}/` : null;
  const planned = own(input.installed, item.path!);
  const desiredModes = kind === "remove" ? null : executablesOf(bundle, item.skill);
  const token = crypto.randomUUID();
  const work = join(root, `.quench-stage-${token}`);
  const sequence = ledger.reduce((max, e) => Math.max(max, e.sequence), 0) + 1;
  const op: JournalOp = {
    sequence,
    kind,
    path,
    base,
    pin,
    work,
    token,
    stage: kind === "remove" ? null : join(work, "new"),
    backup: join(work, "old"),
    stagedId: null,
    backupId: null,
    desired: kind === "remove" ? null : item.desired,
    previous: planned?.treeHash ?? null,
    previousExecutables: planned?.executables ?? null,
    files:
      kind === "remove"
        ? []
        : own(bundle.skills, item.skill)!.files.map((f) => ({
            path: f.path,
            mode: f.mode,
            sha256: f.sha256,
          })),
    exclude:
      kind === "remove"
        ? ours?.gitExclude && checkout
          ? { file: checkout.exclude, line: ours.gitExclude, added: true }
          : null
        : checkout && line
          ? {
              file: checkout.exclude,
              line,
              added: !(await excludeHas({ file: checkout.exclude, line })),
            }
          : null,
  };
  await check(root, kind === "remove" ? "dir" : "dir?");
  await mkdir(root, { recursive: true });
  await check(root, "dir");
  await check(work, "absent");
  await writeJournal(state, op);
  await mkdir(work);
  await writeFile(join(work, MARKER), token, { flag: "wx" });
  await check(work, "dir");
  if (op.stage) {
    await mkdir(op.stage);
    await check(op.stage, "dir");
    op.stagedId = await identity(op.stage);
    await writeJournal(state, op);
    await stage(op, own(input.sources, item.skill)!);
    if (!matches(await rawState(op.stage), op.desired, desiredModes))
      throw new Error(`${item.skill} staged with a different tree hash or mode; plan again`);
    await interrupt?.("staged");
  }
  await check(path, planned ? "dir" : "absent");
  if (!matches(await rawState(path), planned?.treeHash, planned?.executables ?? null))
    throw new Conflict(`${item.path} changed since the plan`);
  if (planned) {
    await check(op.backup, "absent");
    op.backupId = await identity(path);
    await writeJournal(state, op);
    await rename(path, op.backup);
    await interrupt?.("backed-up");
    await check(op.backup, "dir");
    await check(path, "absent");
    if ((await identity(op.backup)) !== op.backupId)
      throw new Conflict(`${item.path} was replaced during the move`);
  }
  if (op.stage) {
    await check(op.stage, "dir");
    await check(path, "absent");
    await rename(op.stage, path);
    await interrupt?.("swapped");
    await check(path, "dir");
    if (
      (await identity(path)) !== op.stagedId ||
      !matches(await rawState(path), op.desired, desiredModes)
    )
      throw new Conflict(`${item.path} changed during the swap`);
    if (op.exclude?.added) await addExclude(op.exclude);
  }
  const location =
    at.scope === "project"
      ? { scope: "project" as const, remote: at.remote, checkout: at.checkout! }
      : { scope: "global" as const };
  const next = [
    ...ledger,
    {
      path: item.path!,
      skill: item.skill,
      treeHash: (op.desired ?? ours?.treeHash)!,
      executables: desiredModes ?? ours?.executables ?? [],
      harness: item.harness,
      location: ours?.location ?? location,
      kind,
      sequence,
      appliedAt: (input.now ?? (() => new Date().toISOString()))(),
      gitExclude: kind === "remove" ? (ours?.gitExclude ?? null) : op.exclude?.added ? line : null,
    },
  ];
  await writeLedger(state, next);
  await interrupt?.("committed");
  if (kind === "remove" && op.exclude) await dropExclude(op.exclude, next);
  await tidy(op);
  await writeJournal(state, null);
}
