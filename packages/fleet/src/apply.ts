import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import type { BundleManifest } from "./bundle.ts";
import { own, TreeHash } from "./common.ts";
import { installedTree } from "./disk.ts";
import { LedgerEntry, owned } from "./ledger.ts";
import { executablesOf, type Plan, type PlanItem, type ProjectCheckout } from "./plan.ts";
import { sha256, treeHash } from "./tree-hash.ts";

const Exclude = z.object({ file: z.string(), line: z.string() }).strict();

export const JournalOp = z
  .object({
    sequence: z.number().int().nonnegative(),
    kind: z.enum(["install", "update", "remove"]),
    path: z.string(),
    stage: z.string().nullable(),
    backup: z.string(),
    desired: TreeHash,
    exclude: Exclude.nullable(),
  })
  .strict();
export type JournalOp = z.infer<typeof JournalOp>;

export const statePaths = (state: string) => ({
  ledger: join(state, "ledger.json"),
  journal: join(state, "journal.json"),
  lock: join(state, "lock"),
});

export async function inspect(path: string) {
  const info = await lstat(path).catch(() => null);
  if (!info) return undefined;
  if (info.isSymbolicLink() && !(await realpath(path).catch(() => null)))
    return { treeHash: treeHash([]), symlink: true, executables: null };
  return installedTree(path);
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

async function writeAtomic(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, text);
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

export async function withLock<T>(state: string, work: () => Promise<T>): Promise<T> {
  await mkdir(state, { recursive: true });
  const { lock } = statePaths(state);
  const take = () => writeFile(lock, String(process.pid), { flag: "wx" });
  await take().catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(await readFile(lock, "utf8").catch(() => ""));
    if (pid && alive(pid)) throw new Error(`another apply is running (pid ${pid})`);
    await rm(lock, { force: true });
    await take();
  });
  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
}

const excludeLines = async (file: string) =>
  (await readFile(file, "utf8").catch(() => "")).split(/\r?\n/);

async function addExclude({ file, line }: z.infer<typeof Exclude>) {
  const lines = await excludeLines(file);
  if (lines.includes(line)) return;
  const text = lines.join("\n");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
}

async function dropExclude({ file, line }: z.infer<typeof Exclude>, ledger: LedgerEntry[]) {
  if ([...owned(ledger).values()].some((e) => e.gitExclude === line)) return;
  const lines = await excludeLines(file);
  if (lines.includes(line)) await writeFile(file, lines.filter((l) => l !== line).join("\n"));
}

const removeTree = (path: string) => rm(path, { recursive: true, force: true });

const tidy = async (op: JournalOp) => {
  await removeTree(op.backup);
  if (op.stage) await removeTree(op.stage);
  await rmdir(dirname(op.backup)).catch(() => undefined);
};

export async function recover(state: string): Promise<string | null> {
  const op = await readJournal(state);
  if (!op) return null;
  const ledger = await readLedger(state);
  if (ledger.some((e) => e.sequence === op.sequence)) {
    if (op.kind === "remove" && op.exclude) await dropExclude(op.exclude, ledger);
  } else {
    if (await exists(op.backup)) {
      if (await exists(op.path)) {
        const now = await inspect(op.path);
        if (op.kind === "remove" || now?.treeHash !== op.desired)
          throw new Error(
            `cannot recover ${op.path}: it changed after an interrupted apply; the earlier copy is at ${op.backup}`,
          );
        await removeTree(op.path);
      }
      await rename(op.backup, op.path);
    } else if (
      op.kind === "install" &&
      (await exists(op.path)) &&
      (await inspect(op.path))?.treeHash === op.desired
    )
      await removeTree(op.path);
    if (op.kind === "install" && op.exclude) await dropExclude(op.exclude, ledger);
  }
  await tidy(op);
  await writeJournal(state, null);
  return `recovered an interrupted ${op.kind} of ${op.path}`;
}

async function stage(dir: string, skill: BundleManifest["skills"][string], source: string) {
  await removeTree(dir);
  await mkdir(dir, { recursive: true });
  for (const file of skill.files) {
    const from = join(source, ...file.path.split("/"));
    const to = join(dir, ...file.path.split("/"));
    await mkdir(dirname(to), { recursive: true });
    const bytes =
      file.mode === "120000" ? await readlink(from, { encoding: "buffer" }) : await readFile(from);
    if (sha256(bytes) !== file.sha256)
      throw new Error(`${from} changed since the plan; plan again`);
    if (file.mode === "120000") await symlink(bytes.toString(), to);
    else await writeFile(to, bytes, { mode: file.mode === "100755" ? 0o755 : 0o644 });
  }
}

export type ApplyInput = {
  plan: Plan;
  bundle: BundleManifest;
  sources: Record<string, string>;
  state: string;
  absolute: (path: string) => string;
  projects?: (ProjectCheckout & { exclude: string })[];
  now?: () => string;
  interrupt?: (step: "staged" | "backed-up" | "swapped" | "committed") => void | Promise<void>;
};

export const ACTIONABLE = ["install", "update", "remove"] as const;

const same = (now: { treeHash: string; symlink: boolean } | undefined, item: PlanItem) =>
  item.installed
    ? now?.treeHash === item.installed.treeHash && now.symlink === item.installed.symlink
    : !now;

export async function applyPlan(input: ApplyInput): Promise<PlanItem[]> {
  const { plan, bundle, sources, state, absolute, interrupt } = input;
  const now = input.now ?? (() => new Date().toISOString());
  let ledger = await readLedger(state);
  const applied: PlanItem[] = [];
  for (const item of plan.items) {
    if (!(ACTIONABLE as readonly string[]).includes(item.action) || !item.path) continue;
    const kind = item.action as JournalOp["kind"];
    const path = absolute(item.path);
    const ours = owned(ledger).get(item.path);
    const sequence = ledger.reduce((max, e) => Math.max(max, e.sequence), 0) + 1;
    const work = join(dirname(path), ".quench-stage");
    const at = item.location;
    const checkout =
      at.scope === "project" ? input.projects?.find((p) => p.checkout === at.checkout) : undefined;
    const exclude = checkout
      ? {
          file: checkout.exclude,
          line: `/${relative(absolute(checkout.checkout), path).replaceAll("\\", "/")}/`,
        }
      : null;
    const op: JournalOp = {
      sequence,
      kind,
      path,
      stage: kind === "remove" ? null : join(work, `${item.skill}.${sequence}.new`),
      backup: join(work, `${item.skill}.${sequence}.old`),
      desired: (item.desired ?? ours?.treeHash)!,
      exclude,
    };
    await mkdir(work, { recursive: true });
    await writeJournal(state, op);
    if (op.stage) {
      const skill = own(bundle.skills, item.skill)!;
      await stage(op.stage, skill, own(sources, item.skill)!);
      if ((await installedTree(op.stage))?.treeHash !== item.desired)
        throw new Error(`${item.skill} staged with a different tree hash; plan again`);
      await interrupt?.("staged");
    }
    if (!same(await inspect(path), item))
      throw new Error(`${item.path} changed since the plan; plan again`);
    if (await exists(path)) {
      await rename(path, op.backup);
      await interrupt?.("backed-up");
    }
    if (op.stage) {
      await rename(op.stage, path);
      await interrupt?.("swapped");
      if (exclude) await addExclude(exclude);
    }
    const location =
      item.location.scope === "project"
        ? {
            scope: "project" as const,
            remote: item.location.remote,
            checkout: item.location.checkout!,
          }
        : { scope: "global" as const };
    ledger = [
      ...ledger,
      {
        path: item.path,
        skill: item.skill,
        treeHash: op.desired,
        executables:
          kind === "remove" ? (ours?.executables ?? []) : executablesOf(bundle, item.skill),
        harness: item.harness,
        location: ours?.location ?? location,
        kind,
        sequence,
        appliedAt: now(),
        gitExclude: exclude?.line ?? null,
      },
    ];
    await writeLedger(state, ledger);
    await interrupt?.("committed");
    if (kind === "remove" && exclude) await dropExclude(exclude, ledger);
    await tidy(op);
    await writeJournal(state, null);
    applied.push(item);
  }
  return applied;
}
