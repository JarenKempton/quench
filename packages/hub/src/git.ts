import { join, posix } from "node:path";
import {
  excluded,
  foldCollision,
  insideFolder,
  sha256,
  treeHashOf,
  type FileMode,
  type TreeHash,
} from "@quench/fleet";
import type { DataDir } from "./data.ts";

export const BRANCH = "refs/heads/main";

const BLOB_MODES = new Set(["100644", "100755", "120000"]);

const TRANSPORTS = [
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "protocol.ssh.allow=always",
  "-c",
  "protocol.file.allow=always",
];

export function gitSource(source: string) {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(source)?.[1]?.toLowerCase();
  const ok =
    source !== "" &&
    !source.startsWith("-") &&
    !source.includes("::") &&
    !["\0", "\r", "\n"].some((c) => source.includes(c)) &&
    (scheme === undefined ? true : scheme === "https" || scheme === "ssh");
  if (!ok)
    throw new GitError(
      `unsupported git source ${JSON.stringify(source)}: use https://, ssh://, git@host:path or a local path`,
    );
  return source;
}

const escapes = (path: string, target: string) => {
  if (
    target === "" ||
    target.includes("\\") ||
    target.includes("\0") ||
    target.startsWith("/") ||
    /^[A-Za-z]:/.test(target)
  )
    return true;
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  return resolved === ".." || resolved.startsWith("../");
};

const IDENTITY = {
  GIT_AUTHOR_NAME: "Quench hub",
  GIT_AUTHOR_EMAIL: "hub@quench.invalid",
  GIT_COMMITTER_NAME: "Quench hub",
  GIT_COMMITTER_EMAIL: "hub@quench.invalid",
};

const SETTINGS = ["-c", "core.autocrlf=false", "-c", "core.quotePath=false"];

export class GitError extends Error {}

export type Guard = () => void;

export class StaleHead extends Error {
  constructor(readonly expected: string | null) {
    super("the hub's skills changed since this page loaded; reload and try again");
  }
}

export type Commit = { sha: string; subject: string; date: string };

export type Version = { commit: string; treeHash: TreeHash | null };

const LITERAL = { GIT_LITERAL_PATHSPECS: "1" };

type TreeLine = { mode: string; type: string; sha: string; path: string };

const treeLines = (stdout: Uint8Array): TreeLine[] =>
  new TextDecoder()
    .decode(stdout)
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode = "", type = "", sha = ""] = line.slice(0, tab).split(" ");
      return { mode, type, sha, path: line.slice(tab + 1) };
    });

export class Repo {
  readonly dir: string;

  constructor(readonly data: DataDir) {
    this.dir = data.path("skills.git");
  }

  async git(
    args: string[],
    options: { input?: string | Uint8Array; env?: Record<string, string>; ok?: number[] } = {},
  ) {
    const dir = await this.data.existing("skills.git");
    const proc = Bun.spawn(["git", ...SETTINGS, ...args], {
      env: { ...process.env, ...IDENTITY, GIT_DIR: dir, ...options.env },
      stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).bytes(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (!(options.ok ?? [0]).includes(code))
      throw new GitError(`git ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`);
    return { stdout, text: new TextDecoder().decode(stdout).trim(), code };
  }

  scratch(prefix: string) {
    return this.data.fresh(["tmp"], prefix);
  }

  exists() {
    return Bun.file(join(this.dir, "HEAD")).exists();
  }

  async init() {
    await this.data.dir("skills.git");
    await this.git(["init", "--quiet", "--bare", "--initial-branch=main", this.dir]);
  }

  async head(): Promise<string | null> {
    const { text, code } = await this.git(["rev-parse", "--verify", "--quiet", BRANCH], {
      ok: [0, 1],
    });
    return code === 0 ? text : null;
  }

  async fetchHead(source: string) {
    await this.git([
      ...TRANSPORTS,
      "-c",
      "transfer.fsckObjects=true",
      "fetch",
      "--quiet",
      "--no-tags",
      "--",
      gitSource(source),
      "HEAD",
    ]);
    const { text } = await this.git(["rev-parse", "FETCH_HEAD"]);
    await this.git(["update-ref", BRANCH, text, ""]);
    return text;
  }

  async show(commit: string, path: string): Promise<string | null> {
    const { stdout, code } = await this.git(["cat-file", "blob", `${commit}:${path}`], {
      ok: [0, 128],
    });
    return code === 0 ? new TextDecoder().decode(stdout) : null;
  }

  async files(commit: string) {
    const { text } = await this.git(["ls-tree", "-r", "--name-only", "-z", commit]);
    return text.split("\0").filter(Boolean);
  }

  async log(limit: number): Promise<Commit[]> {
    const { text } = await this.git(["log", `-${limit}`, "--format=%H%x1f%s%x1f%cI%x1e", BRANCH]);
    return text
      .split("\x1e")
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [sha = "", subject = "", date = ""] = r.split("\x1f");
        return { sha, subject, date };
      });
  }

  async blob(content: string | Uint8Array) {
    return (await this.git(["hash-object", "-w", "--stdin"], { input: content })).text;
  }

  async diff(before: string | null, after: string, path: string) {
    const scratch = await this.scratch("diff-");
    const dir = scratch.path;
    try {
      await this.data.write([...scratch.parts, "a"], before ?? "");
      await this.data.write([...scratch.parts, "b"], after);
      const { GIT_DIR: _, ...env } = process.env;
      await this.data.existing(...scratch.parts);
      const proc = Bun.spawn(
        ["git", ...SETTINGS, "diff", "--no-index", "--no-color", "--", "a", "b"],
        { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
      );
      const [text, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code > 1) throw new GitError(`git diff failed: ${stderr.trim()}`);
      return text
        .trimEnd()
        .replace(/^diff --git a\/a b\/b$/m, `diff --git a/${path} b/${path}`)
        .replace(/^--- a\/a$/m, `--- a/${path}`)
        .replace(/^\+\+\+ b\/b$/m, `+++ b/${path}`);
    } finally {
      await this.data.remove(...scratch.parts);
    }
  }

  private async withIndex<T>(run: (env: Record<string, string>) => Promise<T>) {
    const scratch = await this.scratch("index-");
    try {
      return await run({ GIT_INDEX_FILE: join(scratch.path, "index") });
    } finally {
      await this.data.remove(...scratch.parts);
    }
  }

  private async land(
    base: string | null,
    tree: string,
    message: string,
    guard: Guard,
  ): Promise<string> {
    const parents = base ? ["-p", base] : [];
    const { text: commit } = await this.git(
      ["commit-tree", "--no-gpg-sign", tree, ...parents, "-F", "-"],
      { input: message },
    );
    guard();
    const { code } = await this.git(["update-ref", BRANCH, commit, base ?? ""], { ok: [0, 128] });
    if (code !== 0) throw new StaleHead(base);
    return commit;
  }

  async commitFile(
    base: string | null,
    path: string,
    content: string,
    message: string,
    guard: Guard = () => {},
  ) {
    if ((await this.head()) !== base) throw new StaleHead(base);
    const blob = await this.blob(content);
    return this.withIndex(async (env) => {
      await this.git(base ? ["read-tree", base] : ["read-tree", "--empty"], { env });
      await this.git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
      const { text: tree } = await this.git(["write-tree"], { env });
      return this.land(base, tree, message, guard);
    });
  }

  async revert(base: string, commit: string, guard: Guard = () => {}) {
    if ((await this.head()) !== base) throw new StaleHead(base);
    const { text: subject } = await this.git(["log", "-1", "--format=%s", commit]);
    const patch = await this.git(["diff-tree", "-p", "--binary", "--root", commit]);
    return this.withIndex(async (env) => {
      await this.git(["read-tree", base], { env });
      await this.git(["apply", "--cached", "-R"], { env, input: patch.stdout }).catch(() => {
        throw new GitError(`${commit.slice(0, 12)} cannot be reverted cleanly on top of HEAD`);
      });
      const { text: tree } = await this.git(["write-tree"], { env });
      return this.land(
        base,
        tree,
        `Revert "${subject}"\n\nThis reverts commit ${commit}.\n`,
        guard,
      );
    });
  }

  private async blobs<T extends TreeLine>(entries: T[]) {
    if (!entries.length) return [];
    const batch = await this.git(["cat-file", "--batch"], {
      input: entries.map((e) => e.sha).join("\n") + "\n",
    });
    const out = batch.stdout;
    let offset = 0;
    return entries.map((entry) => {
      const newline = out.indexOf(0x0a, offset);
      const [sha, type, size] = new TextDecoder().decode(out.subarray(offset, newline)).split(" ");
      if (sha !== entry.sha || type !== "blob") throw new GitError(`cannot read ${entry.path}`);
      const bytes = out.subarray(newline + 1, newline + 1 + Number(size));
      offset = newline + 1 + Number(size) + 1;
      return { ...entry, bytes };
    });
  }

  async treeHashAt(commit: string, folder: string): Promise<TreeHash | null> {
    const prefix = `${folder}/`;
    const { stdout } = await this.git(
      ["ls-tree", "-r", "-z", "--full-tree", commit, "--", prefix],
      {
        env: LITERAL,
      },
    );
    const entries = treeLines(stdout)
      .filter((e) => e.type === "blob" && BLOB_MODES.has(e.mode) && e.path.startsWith(prefix))
      .map((e) => ({ ...e, path: e.path.slice(prefix.length) }))
      .filter((e) => !excluded(e.path));
    if (!entries.some((e) => e.path === "SKILL.md")) return null;
    return treeHashOf(
      (await this.blobs(entries)).map((e) => ({
        path: e.path,
        mode: e.mode as FileMode,
        sha256: sha256(e.bytes),
      })),
    );
  }

  async versions(folder: string, limit = 100): Promise<Version[]> {
    const { text } = await this.git(["log", `-${limit}`, "--format=%H", BRANCH, "--", folder], {
      env: LITERAL,
    });
    const commits = text.split("\n").filter(Boolean).reverse();
    return Promise.all(
      commits.map(async (commit) => ({ commit, treeHash: await this.treeHashAt(commit, folder) })),
    );
  }

  async diffCommits(before: string, after: string, folder: string) {
    const { text } = await this.git(
      ["diff", "--no-color", "--no-ext-diff", before, after, "--", folder],
      { env: LITERAL },
    );
    return text;
  }

  async materialize(commit: string, target: string[]) {
    const { stdout } = await this.git(["ls-tree", "-r", "-z", "--full-tree", commit]);
    const entries = treeLines(stdout);
    for (const e of entries) {
      if (e.type !== "blob" || !BLOB_MODES.has(e.mode))
        throw new GitError(`${JSON.stringify(e.path)}: unsupported ${e.type} ${e.mode}`);
      if (!insideFolder(e.path) || excluded(e.path))
        throw new GitError(`${JSON.stringify(e.path)} is not a valid portable path`);
    }
    const collision = foldCollision(entries.map((e) => e.path));
    if (collision) throw new GitError(`duplicate path ${collision.join(" and ")}`);
    const files = await this.blobs(entries);
    for (const f of files)
      if (f.mode === "120000" && escapes(f.path, new TextDecoder().decode(f.bytes)))
        throw new GitError(`${f.path} links outside the tree`);
    const staging = await this.data.fresh(target.slice(0, -1), `${target.at(-1)}.tmp-`);
    try {
      const ordered = [
        ...files.filter((f) => f.mode !== "120000"),
        ...files.filter((f) => f.mode === "120000"),
      ];
      for (const f of ordered) {
        const parts = [...staging.parts, ...f.path.split("/")];
        if (f.mode === "120000")
          await this.data.link(parts, new TextDecoder().decode(f.bytes)).catch(() => undefined);
        else await this.data.write(parts, f.bytes, f.mode === "100755" ? 0o755 : 0o644);
      }
      await this.data.remove(...target);
      await this.data.move(staging.parts, target);
    } catch (error) {
      await this.data.remove(...staging.parts);
      throw error;
    }
  }

  async push(remote: string) {
    await this.git([
      ...TRANSPORTS,
      "push",
      "--quiet",
      "--",
      gitSource(remote),
      `${BRANCH}:${BRANCH}`,
    ]);
  }
}
