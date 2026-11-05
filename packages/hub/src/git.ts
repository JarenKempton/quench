import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export const BRANCH = "refs/heads/main";

const IDENTITY = {
  GIT_AUTHOR_NAME: "Quench hub",
  GIT_AUTHOR_EMAIL: "hub@quench.invalid",
  GIT_COMMITTER_NAME: "Quench hub",
  GIT_COMMITTER_EMAIL: "hub@quench.invalid",
};

const SETTINGS = ["-c", "core.autocrlf=false", "-c", "core.quotePath=false"];

export class GitError extends Error {}

export class StaleHead extends Error {
  constructor(readonly expected: string | null) {
    super("the hub's skills changed since this page loaded; reload and try again");
  }
}

export type Commit = { sha: string; subject: string; date: string };

export class Repo {
  constructor(readonly dir: string) {}

  async git(
    args: string[],
    options: { input?: string | Uint8Array; env?: Record<string, string>; ok?: number[] } = {},
  ) {
    const proc = Bun.spawn(["git", ...SETTINGS, ...args], {
      env: { ...process.env, ...IDENTITY, GIT_DIR: this.dir, ...options.env },
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

  exists() {
    return Bun.file(join(this.dir, "HEAD")).exists();
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    await this.git(["init", "--quiet", "--bare", "--initial-branch=main", this.dir]);
  }

  async head(): Promise<string | null> {
    const { text, code } = await this.git(["rev-parse", "--verify", "--quiet", BRANCH], {
      ok: [0, 1],
    });
    return code === 0 ? text : null;
  }

  async fetchHead(source: string) {
    await this.git(["fetch", "--quiet", "--no-tags", source, "HEAD"]);
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

  async diff(before: string, after: string, path: string) {
    const { text } = await this.git([
      "diff",
      "--no-color",
      `--src-prefix=a/`,
      `--dst-prefix=b/`,
      before,
      after,
    ]);
    return text.replace(/^(diff --git )a\/\S+ b\/\S+/m, `$1a/${path} b/${path}`);
  }

  emptyBlob() {
    return this.blob("");
  }

  private async withIndex<T>(run: (env: Record<string, string>) => Promise<T>) {
    const dir = await mkdtemp(join(tmpdir(), "quench-hub-index-"));
    try {
      return await run({ GIT_INDEX_FILE: join(dir, "index") });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async land(base: string | null, tree: string, message: string): Promise<string> {
    const parents = base ? ["-p", base] : [];
    const { text: commit } = await this.git(
      ["commit-tree", "--no-gpg-sign", tree, ...parents, "-F", "-"],
      { input: message },
    );
    const { code } = await this.git(["update-ref", BRANCH, commit, base ?? ""], { ok: [0, 128] });
    if (code !== 0) throw new StaleHead(base);
    return commit;
  }

  async commitFile(base: string | null, path: string, content: string, message: string) {
    if ((await this.head()) !== base) throw new StaleHead(base);
    const blob = await this.blob(content);
    return this.withIndex(async (env) => {
      await this.git(base ? ["read-tree", base] : ["read-tree", "--empty"], { env });
      await this.git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
      const { text: tree } = await this.git(["write-tree"], { env });
      return this.land(base, tree, message);
    });
  }

  async revert(base: string, commit: string) {
    if ((await this.head()) !== base) throw new StaleHead(base);
    const { text: subject } = await this.git(["log", "-1", "--format=%s", commit]);
    const patch = await this.git(["diff-tree", "-p", "--binary", "--root", commit]);
    return this.withIndex(async (env) => {
      await this.git(["read-tree", base], { env });
      await this.git(["apply", "--cached", "-R"], { env, input: patch.stdout }).catch(() => {
        throw new GitError(`${commit.slice(0, 12)} cannot be reverted cleanly on top of HEAD`);
      });
      const { text: tree } = await this.git(["write-tree"], { env });
      return this.land(base, tree, `Revert "${subject}"\n\nThis reverts commit ${commit}.\n`);
    });
  }

  async materialize(commit: string, target: string) {
    const { stdout } = await this.git(["ls-tree", "-r", "-z", commit]);
    const entries = new TextDecoder()
      .decode(stdout)
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const [meta = "", path = ""] = line.split("\t");
        const [mode = "", type = "", sha = ""] = meta.split(" ");
        return { mode, type, sha, path };
      })
      .filter((e) => e.type === "blob");
    const batch = await this.git(["cat-file", "--batch"], {
      input: entries.map((e) => e.sha).join("\n") + "\n",
    });
    const staging = `${target}.${process.pid}.${Date.now()}.tmp`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    let offset = 0;
    const out = batch.stdout;
    for (const entry of entries) {
      const newline = out.indexOf(0x0a, offset);
      const size = Number(new TextDecoder().decode(out.subarray(offset, newline)).split(" ")[2]);
      const bytes = out.subarray(newline + 1, newline + 1 + size);
      offset = newline + 1 + size + 1;
      const file = join(staging, ...entry.path.split("/"));
      await mkdir(dirname(file), { recursive: true });
      if (entry.mode === "120000") {
        await symlink(new TextDecoder().decode(bytes), file).catch(() => undefined);
        continue;
      }
      await writeFile(file, bytes);
      if (entry.mode === "100755" && process.platform !== "win32") await chmod(file, 0o755);
    }
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  }

  async push(remote: string) {
    await this.git(["push", "--quiet", remote, `${BRANCH}:${BRANCH}`]);
  }
}
